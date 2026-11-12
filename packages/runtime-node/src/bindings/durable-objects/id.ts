import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

import { isMigratingFromCloudflare } from "./migration-mode.js";

export type DurableObjectJurisdiction =
	| "eu"
	| "fedramp"
	| "fedramp-high"
	| "us";

export interface DurableObjectNamespaceNewUniqueIdOptions {
	jurisdiction?: DurableObjectJurisdiction;
}

export interface DurableObjectId {
	toString(): string;
	equals(other: DurableObjectId): boolean;
	readonly name?: string;
	readonly jurisdiction?: string;
}

interface DurableObjectIdData {
	hex: string;
	jurisdiction?: DurableObjectJurisdiction;
	name?: string;
	namespaceFingerprint: string;
}

const idData = new WeakMap<object, DurableObjectIdData>();
// IDs without Orange's signature: Cloudflare's, which objects keep during a migration.
const foreignIds = new WeakSet<object>();

/** True for an ID that Cloudflare created. It came from a migration, not from this namespace. */
export function isForeignDurableObjectId(id: DurableObjectId): boolean {
	return foreignIds.has(id);
}

class DurableObjectIdImplementation implements DurableObjectId {
	readonly jurisdiction?: string;
	readonly name?: string;

	constructor(data: DurableObjectIdData) {
		this.jurisdiction = data.jurisdiction;
		this.name = data.name;
		idData.set(this, data);
	}

	equals(other: DurableObjectId): boolean {
		const ownData = idData.get(this);
		const otherData = idData.get(other);
		return (
			ownData !== undefined &&
			otherData !== undefined &&
			ownData.hex === otherData.hex
		);
	}

	toString(): string {
		const data = idData.get(this);
		if (data === undefined) {
			throw new TypeError("Invalid Durable Object ID receiver");
		}
		return data.hex;
	}
}

/** The parts of an ID that rebuild it in another process or actor. */
export interface DurableObjectIdSnapshot {
	readonly hex: string;
	readonly jurisdiction?: DurableObjectJurisdiction;
	readonly name?: string;
	readonly namespaceFingerprint: string;
}

/** Returns undefined when `value` is not an Orange Durable Object ID. */
export function snapshotDurableObjectId(
	value: unknown,
): DurableObjectIdSnapshot | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const data = idData.get(value);
	if (data === undefined) return undefined;
	return {
		hex: data.hex,
		...(data.jurisdiction === undefined
			? {}
			: { jurisdiction: data.jurisdiction }),
		...(data.name === undefined ? {} : { name: data.name }),
		namespaceFingerprint: data.namespaceFingerprint,
	};
}

export function requireDurableObjectIdSnapshot(
	value: unknown,
): DurableObjectIdSnapshot {
	const field = (key: string): unknown =>
		typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
	const hex = field("hex");
	const jurisdiction = field("jurisdiction");
	const name = field("name");
	const namespaceFingerprint = field("namespaceFingerprint");
	if (
		typeof hex !== "string" ||
		!idPattern.test(hex) ||
		(jurisdiction !== undefined && !isDurableObjectJurisdiction(jurisdiction)) ||
		(name !== undefined && typeof name !== "string") ||
		typeof namespaceFingerprint !== "string"
	) {
		throw new TypeError("Durable Object ID snapshot is invalid");
	}
	return {
		hex: hex.toLowerCase(),
		...(jurisdiction === undefined ? {} : { jurisdiction }),
		...(name === undefined ? {} : { name }),
		namespaceFingerprint,
	};
}

export function restoreDurableObjectId(
	snapshot: DurableObjectIdSnapshot,
): DurableObjectId {
	return createId(
		snapshot.hex,
		snapshot.namespaceFingerprint,
		snapshot.jurisdiction,
		snapshot.name,
	);
}

const idPattern = /^[A-Fa-f0-9]{64}$/;
const namespaceProofOffset = 24;
const namedIdFlag = 0x80;

const jurisdictionCodes: Readonly<
	Record<DurableObjectJurisdiction, number>
> = {
	eu: 1,
	fedramp: 2,
	"fedramp-high": 3,
	us: 4,
};

const jurisdictionsByCode = new Map<number, DurableObjectJurisdiction>(
	[
		[jurisdictionCodes.eu, "eu"],
		[jurisdictionCodes.fedramp, "fedramp"],
		[jurisdictionCodes["fedramp-high"], "fedramp-high"],
		[jurisdictionCodes.us, "us"],
	],
);

export interface DurableObjectIdScope {
	readonly jurisdiction?: DurableObjectJurisdiction;
	assertId(id: DurableObjectId): void;
	idFromName(name: string): DurableObjectId;
	idFromString(id: string, name?: string): DurableObjectId;
	newUniqueId(
		options?: DurableObjectNamespaceNewUniqueIdOptions,
	): DurableObjectId;
}

export interface CreateDurableObjectIdScopeOptions {
	jurisdiction?: DurableObjectJurisdiction;
	namespaceKey: string;
}

function jurisdictionCode(
	jurisdiction: DurableObjectJurisdiction | undefined,
): number {
	return jurisdiction === undefined ? 0 : jurisdictionCodes[jurisdiction];
}

function jurisdictionFromHeader(
	header: number,
): DurableObjectJurisdiction | undefined {
	const code = header & ~namedIdFlag;
	if (code === 0) {
		return undefined;
	}
	return jurisdictionsByCode.get(code);
}

export function isDurableObjectJurisdiction(
	value: unknown,
): value is DurableObjectJurisdiction {
	return (
		value === "eu" ||
		value === "fedramp" ||
		value === "fedramp-high" ||
		value === "us"
	);
}

function createNamespaceFingerprint(namespaceKey: string): string {
	return createHash("sha256")
		.update("open-orange-durable-object-namespace\0")
		.update(namespaceKey)
		.digest("hex");
}

function signId(bytes: Buffer, namespaceKey: string): Buffer {
	return createHmac("sha256", namespaceKey)
		.update("open-orange-durable-object-id\0")
		.update(bytes.subarray(0, namespaceProofOffset))
		.digest()
		.subarray(0, 8);
}

function createId(
	hex: string,
	namespaceFingerprint: string,
	jurisdiction?: DurableObjectJurisdiction,
	name?: string,
): DurableObjectId {
	return new DurableObjectIdImplementation({
		hex,
		jurisdiction,
		name,
		namespaceFingerprint,
	});
}

export function createDurableObjectIdScope(
	options: CreateDurableObjectIdScopeOptions,
): DurableObjectIdScope {
	if (options.namespaceKey.length === 0) {
		throw new TypeError("Durable Object IDs require a namespace key");
	}
	if (
		options.jurisdiction !== undefined &&
		!isDurableObjectJurisdiction(options.jurisdiction)
	) {
		throw new TypeError(
			`Unsupported Durable Object jurisdiction: ${options.jurisdiction}`,
		);
	}
	const namespaceFingerprint = createNamespaceFingerprint(options.namespaceKey);

	function validateJurisdiction(
		jurisdiction: DurableObjectJurisdiction | undefined,
	): DurableObjectJurisdiction | undefined {
		if (
			jurisdiction !== undefined &&
			!isDurableObjectJurisdiction(jurisdiction)
		) {
			throw new TypeError(
				`Unsupported Durable Object jurisdiction: ${jurisdiction}`,
			);
		}
		if (
			options.jurisdiction !== undefined &&
			jurisdiction !== options.jurisdiction
		) {
			throw new TypeError(
				`Durable Object ID jurisdiction ${jurisdiction ?? "default"} does not match namespace jurisdiction ${options.jurisdiction}`,
			);
		}
		return jurisdiction ?? options.jurisdiction;
	}

	function assertId(id: DurableObjectId): void {
		const data = idData.get(id);
		if (data === undefined) {
			throw new TypeError("Invalid Durable Object ID");
		}
		if (data.namespaceFingerprint !== namespaceFingerprint) {
			throw new TypeError("ID is not for this Durable Object class");
		}
		validateJurisdiction(data.jurisdiction);
	}

	return {
		jurisdiction: options.jurisdiction,
		assertId,
		idFromName(rawName): DurableObjectId {
			// workerd converts the name with ToString, so idFromName(5) names "5".
			const name = `${rawName}`;
			const jurisdiction = options.jurisdiction;
			const bytes = Buffer.alloc(32);
			bytes[0] = namedIdFlag | jurisdictionCode(jurisdiction);
			const digest = createHash("sha256")
				.update("open-orange-durable-object-name\0")
				.update(options.namespaceKey)
				.update("\0")
				.update(jurisdiction ?? "")
				.update("\0")
				.update(name)
				.digest();
			digest.copy(bytes, 1, 0, namespaceProofOffset - 1);
			signId(bytes, options.namespaceKey).copy(bytes, namespaceProofOffset);
			return createId(
				bytes.toString("hex"),
				namespaceFingerprint,
				jurisdiction,
				name,
			);
		},
		// Workerd restores a persisted name onto an ID parsed from its string form.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/actor-id-impl.c%2B%2B#L89-L96
		idFromString(value, name): DurableObjectId {
			if (!idPattern.test(value)) {
				throw new TypeError(
					"Invalid Durable Object ID. Durable Object IDs must be 64 hex digits.",
				);
			}
			const canonical = value.toLowerCase();
			const bytes = Buffer.from(canonical, "hex");
			const signature = bytes.subarray(namespaceProofOffset);
			const expectedSignature = signId(bytes, options.namespaceKey);
			if (!timingSafeEqual(signature, expectedSignature)) {
				if (isMigratingFromCloudflare()) {
					// Apps store Cloudflare IDs, so they must keep working after the move. Nothing here can
					// tell one from an Orange ID of another class, which passes too. Cloudflare rejects that
					// one at the export, so its object fails its calls and never serves empty data.
					const foreign = createId(canonical, namespaceFingerprint, options.jurisdiction, name);
					foreignIds.add(foreign);
					return foreign;
				}
				throw new TypeError(
					"Invalid Durable Object ID. The ID does not match this Durable Object class.",
				);
			}
			const header = Number.parseInt(canonical.slice(0, 2), 16);
			const jurisdiction = jurisdictionFromHeader(header);
			const jurisdictionBits = header & ~namedIdFlag;
			if (jurisdictionBits !== 0 && jurisdiction === undefined) {
				throw new TypeError("Invalid Durable Object ID jurisdiction");
			}
			validateJurisdiction(jurisdiction);
			return createId(canonical, namespaceFingerprint, jurisdiction, name);
		},
		newUniqueId(idOptions = {}): DurableObjectId {
			const jurisdiction = validateJurisdiction(idOptions.jurisdiction);
			const bytes = Buffer.alloc(32);
			bytes[0] = jurisdictionCode(jurisdiction);
			randomBytes(namespaceProofOffset - 1).copy(bytes, 1);
			signId(bytes, options.namespaceKey).copy(bytes, namespaceProofOffset);
			return createId(
				bytes.toString("hex"),
				namespaceFingerprint,
				jurisdiction,
			);
		},
	};
}

// ID shape and class-scoping follow Miniflare v2's workerd-compatible model:
// https://github.com/cloudflare/miniflare/blob/12f6f915e08fbf3c7c5298e5131153c5e6e11d57/packages/durable-objects/src/namespace.ts#L212-L297
// Unlike that older emulator, Orange validates the payload with its namespace
// key, as required by workerd's namespace contract:
// https://github.com/cloudflare/workerd/blob/dc27e996c4ab8e8849cc6229ae816b3d426f08ef/src/workerd/server/workerd.capnp#L615-L627
// The header also stores current Cloudflare jurisdiction metadata so
// idFromString() can preserve it without a compatibility profile.
