import { writeFile } from "node:fs/promises";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function claimedGlobalNames(support: unknown): string[] {
	if (!isRecord(support) || !isRecord(support.globals)) {
		return [];
	}
	return Object.entries(support.globals)
		.filter(
			([, claim]) =>
				isRecord(claim) &&
				(claim.status === "partial" || claim.status === "implemented"),
		)
		.map(([name]) => name)
		.sort();
}

function partialGlobalNames(support: unknown): string[] {
	if (!isRecord(support) || !isRecord(support.globals)) {
		return [];
	}
	return Object.entries(support.globals)
		.filter(([, claim]) => isRecord(claim) && claim.status === "partial")
		.map(([name]) => name)
		.sort();
}

/** The Cloudflare members that each partial global claim says Orange does not provide. */
export function absentGlobalMembers(support: unknown): Map<string, string[]> {
	const absent = new Map<string, string[]>();
	if (!isRecord(support) || !isRecord(support.globals)) {
		return absent;
	}
	for (const [name, claim] of Object.entries(support.globals)) {
		if (!isRecord(claim) || claim.status !== "partial" || !Array.isArray(claim.absentMembers)) {
			continue;
		}
		const members = claim.absentMembers.filter(
			(member): member is string => typeof member === "string",
		);
		absent.set(name, [...members].sort());
	}
	return absent;
}

interface BindingClaim {
	name: string;
	typeName: string;
}

export interface ModuleExportClaim {
	exportName: string;
	moduleSpecifier: string;
	status: "implemented" | "partial";
}

export function claimedModuleExports(support: unknown): ModuleExportClaim[] {
	if (!isRecord(support) || !isRecord(support.modules)) {
		return [];
	}
	const claims: ModuleExportClaim[] = [];
	for (const claim of Object.values(support.modules)) {
		if (
			!isRecord(claim) ||
			(claim.status !== "partial" && claim.status !== "implemented") ||
			!Array.isArray(claim.declarations)
		) {
			continue;
		}
		const declarations = claim.declarations.filter(isRecord);
		const direct = declarations.find(
			(declaration) =>
				typeof declaration.moduleSpecifier === "string" &&
				typeof declaration.name === "string" &&
				declaration.kind !== "export-assignment",
		);
		const assignment = declarations.find(
			(declaration) =>
				typeof declaration.moduleSpecifier === "string" &&
				declaration.kind === "export-assignment",
		);
		const namespaceExport = declarations.find(
			(declaration) =>
				declaration.moduleSpecifier === undefined &&
				declaration.exported === true &&
				typeof declaration.name === "string" &&
				Array.isArray(declaration.namespacePath),
		);
		const moduleSpecifier =
			direct?.moduleSpecifier ?? assignment?.moduleSpecifier;
		const exportName = direct?.name ?? namespaceExport?.name;
		if (
			typeof moduleSpecifier !== "string" ||
			typeof exportName !== "string" ||
			!moduleSpecifier.startsWith("cloudflare:") ||
			!/^[$A-Z_a-z][$\w]*$/.test(exportName)
		) {
			continue;
		}
		claims.push({
			exportName,
			moduleSpecifier,
			status: claim.status,
		});
	}
	return claims.sort((left, right) =>
		`${left.moduleSpecifier}\0${left.exportName}`.localeCompare(
			`${right.moduleSpecifier}\0${right.exportName}`,
		),
	);
}

function claimedBindings(support: unknown): BindingClaim[] {
	if (!isRecord(support) || !isRecord(support.bindings)) {
		return [];
	}
	const claims: BindingClaim[] = [];
	for (const [name, claim] of Object.entries(support.bindings)) {
		if (
			!isRecord(claim) ||
			(claim.status !== "partial" && claim.status !== "implemented") ||
			!Array.isArray(claim.declarations) ||
			claim.declarations.length !== 1
		) {
			continue;
		}
		const declaration: unknown = claim.declarations[0];
		if (
			!isRecord(declaration) ||
			typeof declaration.name !== "string" ||
			!/^[$A-Z_a-z][$\w]*$/.test(declaration.name)
		) {
			continue;
		}
		claims.push({ name, typeName: declaration.name });
	}
	return claims.sort((left, right) => left.name.localeCompare(right.name));
}

function claimedEvents(support: unknown): BindingClaim[] {
	if (!isRecord(support) || !isRecord(support.events)) {
		return [];
	}
	const claims: BindingClaim[] = [];
	for (const [name, claim] of Object.entries(support.events)) {
		if (
			!isRecord(claim) ||
			(claim.status !== "partial" && claim.status !== "implemented") ||
			!Array.isArray(claim.declarations) ||
			claim.declarations.length !== 1
		) {
			continue;
		}
		const declaration: unknown = claim.declarations[0];
		if (
			!isRecord(declaration) ||
			typeof declaration.name !== "string" ||
			!/^[$A-Z_a-z][$\w]*$/.test(declaration.name)
		) {
			continue;
		}
		claims.push({ name, typeName: declaration.name });
	}
	return claims.sort((left, right) => left.name.localeCompare(right.name));
}

export function renderGlobalTypeChecks(
	globalNames: readonly string[],
	partialNames: readonly string[] = [],
	bindingClaims: readonly BindingClaim[] = [],
	moduleClaims: readonly ModuleExportClaim[] = [],
	eventClaims: readonly BindingClaim[] = [],
	absentMembers: ReadonlyMap<string, readonly string[]> = new Map(),
): string {
	for (const name of globalNames) {
		if (!/^[$A-Z_a-z][$\w]*$/.test(name)) {
			throw new Error(
				`Cannot emit a type check for non-identifier global ${name}`,
			);
		}
	}
	const claimedNames =
		globalNames.length === 0
			? "never"
			: globalNames.map((name) => JSON.stringify(name)).join(" | ");
	const claimedBindingNames =
		bindingClaims.length === 0
			? "never"
			: bindingClaims.map((claim) => JSON.stringify(claim.name)).join(" | ");
	const moduleSpecifiers = [
		...new Set(moduleClaims.map((claim) => claim.moduleSpecifier)),
	];
	const claimedModuleSpecifiers =
		moduleSpecifiers.length === 0
			? "never"
			: moduleSpecifiers
					.map((specifier) => JSON.stringify(specifier))
					.join(" | ");
	const claimedEventNames =
		eventClaims.length === 0
			? "never"
			: eventClaims.map((claim) => JSON.stringify(claim.name)).join(" | ");
	const partials = new Set(partialNames);
	const valueChecks = globalNames
		.map((name, index) => {
			const absent = absentMembers.get(name) ?? [];
			const absentUnion = absent.map((member) => JSON.stringify(member)).join(" | ");
			const comparison = !partials.has(name)
				? `type GlobalValueCheck${index} = Assert<IsExact<ActualGlobal${index}, ExpectedGlobal${index}>>;`
				: absent.length === 0
					? `declare const partialGlobal${index}: ActualGlobal${index};
const partialCompatibility${index}: ExpectedGlobal${index} = partialGlobal${index};`
					: `type AbsentMembers${index} = ${absentUnion};
type AbsentMembersAreCloudflareMembers${index} = Assert<IsExact<Exclude<AbsentMembers${index}, keyof ExpectedGlobal${index}>, never>>;
type AbsentMembersAreAbsent${index} = Assert<IsExact<Extract<AbsentMembers${index}, keyof ActualGlobal${index}>, never>>;
type PartialExpectedGlobal${index} = {
	[Key in Exclude<keyof ExpectedGlobal${index}, AbsentMembers${index}>]: IsExact<ExpectedGlobal${index}[Key], ExpectedGlobal${index}> extends true
		? PartialExpectedGlobal${index}
		: ExpectedGlobal${index}[Key];
};
declare const partialGlobal${index}: ActualGlobal${index};
const partialCompatibility${index}: PartialExpectedGlobal${index} = partialGlobal${index};`;
			return `type ExpectedGlobal${index} = typeof ${name};
type ActualGlobal${index} = typeof globalImplementations[${JSON.stringify(name)}];
${comparison}`;
		})
		.join("\n\n");
	const bindingChecks = bindingClaims
		.map(
			(claim, index) => `type ExpectedBinding${index} = ${claim.typeName};
type ActualBinding${index} = ReturnType<(typeof bindingFactories)[${JSON.stringify(claim.name)}]>;
type BindingValueCheck${index} = Assert<IsExact<ActualBinding${index}, ExpectedBinding${index}>>;`,
		)
		.join("\n\n");
	const moduleChecks = moduleSpecifiers
		.map((moduleSpecifier, moduleIndex) => {
			const exports = moduleClaims.filter(
				(claim) => claim.moduleSpecifier === moduleSpecifier,
			);
			const exportNames = exports
				.map((claim) => JSON.stringify(claim.exportName))
				.join(" | ");
			const exportChecks = exports
				.map((claim, exportIndex) => {
					const expected = `ExpectedModule${moduleIndex}Export${exportIndex}`;
					const actual = `ActualModule${moduleIndex}Export${exportIndex}`;
					const isDurableObjectBase =
						claim.moduleSpecifier === "cloudflare:workers" &&
						claim.exportName === "DurableObject";
					const isRpcTargetBase =
						claim.moduleSpecifier === "cloudflare:workers" &&
						claim.exportName === "RpcTarget";
					const isRpcStubConstructor =
						claim.moduleSpecifier === "cloudflare:workers" &&
						claim.exportName === "RpcStub";
					const comparison =
						claim.status === "partial" && isDurableObjectBase
							? `type ExpectedModule${moduleIndex}Export${exportIndex}PublicInstance = Omit<InstanceType<${expected}>, typeof Rpc.__DURABLE_OBJECT_BRAND>;
type ActualModule${moduleIndex}Export${exportIndex}PublicInstance = InstanceType<${actual}>;
declare const partialModule${moduleIndex}Export${exportIndex}Instance: ActualModule${moduleIndex}Export${exportIndex}PublicInstance;
const partialModule${moduleIndex}Export${exportIndex}InstanceCompatibility: ExpectedModule${moduleIndex}Export${exportIndex}PublicInstance = partialModule${moduleIndex}Export${exportIndex}Instance;
class PartialModule${moduleIndex}Export${exportIndex}ConstructorProbe extends moduleImplementations[${JSON.stringify(moduleSpecifier)}][${JSON.stringify(claim.exportName)}] {}
declare const partialModule${moduleIndex}Export${exportIndex}ConstructorArguments: ConstructorParameters<${expected}>;
new PartialModule${moduleIndex}Export${exportIndex}ConstructorProbe(...partialModule${moduleIndex}Export${exportIndex}ConstructorArguments);`
							: claim.status === "partial" && isRpcTargetBase
								? `type ExpectedModule${moduleIndex}Export${exportIndex}PublicInstance = Omit<InstanceType<${expected}>, typeof Rpc.__RPC_TARGET_BRAND>;
type ActualModule${moduleIndex}Export${exportIndex}PublicInstance = InstanceType<${actual}>;
declare const partialModule${moduleIndex}Export${exportIndex}Instance: ActualModule${moduleIndex}Export${exportIndex}PublicInstance;
const partialModule${moduleIndex}Export${exportIndex}InstanceCompatibility: ExpectedModule${moduleIndex}Export${exportIndex}PublicInstance = partialModule${moduleIndex}Export${exportIndex}Instance;
class PartialModule${moduleIndex}Export${exportIndex}ConstructorProbe extends moduleImplementations[${JSON.stringify(moduleSpecifier)}][${JSON.stringify(claim.exportName)}] {}`
								: claim.status === "partial" && isRpcStubConstructor
									? `interface ExpectedRpcStubFixtureTarget extends Rpc.RpcTargetBranded {
	readonly label: string;
	ping(value: string): string;
}
class ActualRpcStubFixtureTarget extends moduleImplementations[${JSON.stringify(moduleSpecifier)}]["RpcTarget"] {
	get label(): string { return "fixture"; }
	ping(value: string): string { return value; }
}
const actualRpcStubFixture = new moduleImplementations[${JSON.stringify(moduleSpecifier)}][${JSON.stringify(claim.exportName)}](new ActualRpcStubFixtureTarget());
type ExpectedRpcStubFixturePublic = Pick<Rpc.Stub<ExpectedRpcStubFixtureTarget>, "label" | "ping" | typeof Symbol.dispose>;
type ActualRpcStubFixturePublic = Pick<typeof actualRpcStubFixture, "label" | "ping" | typeof Symbol.dispose>;
type RpcStubFixturePublicCheck = Assert<IsExact<ActualRpcStubFixturePublic, ExpectedRpcStubFixturePublic>>;
type RpcStubDupParametersCheck = Assert<IsExact<Parameters<typeof actualRpcStubFixture.dup>, Parameters<Rpc.Stub<ExpectedRpcStubFixtureTarget>["dup"]>>>;
type ActualRpcStubDuplicatePublic = Pick<ReturnType<typeof actualRpcStubFixture.dup>, "label" | "ping" | typeof Symbol.dispose>;
type RpcStubDuplicatePublicCheck = Assert<IsExact<ActualRpcStubDuplicatePublic, ExpectedRpcStubFixturePublic>>;
const actualRpcCallableFixture = new moduleImplementations[${JSON.stringify(moduleSpecifier)}][${JSON.stringify(claim.exportName)}]((value: string) => value);
type ExpectedRpcCallableFixture = Rpc.Stub<(value: string) => string>;
type RpcStubCallableParametersCheck = Assert<IsExact<Parameters<typeof actualRpcCallableFixture>, Parameters<ExpectedRpcCallableFixture>>>;
type RpcStubCallableResultCheck = Assert<IsExact<ReturnType<typeof actualRpcCallableFixture>, ReturnType<ExpectedRpcCallableFixture>>>;`
									: claim.status === "partial"
										? `declare const partialModule${moduleIndex}Export${exportIndex}: ${actual};\nconst partialModuleCompatibility${moduleIndex}Export${exportIndex}: ${expected} = partialModule${moduleIndex}Export${exportIndex};`
										: `type ModuleValueCheck${moduleIndex}Export${exportIndex} = Assert<IsExact<${actual}, ${expected}>>;`;
					return `type ${expected} = typeof import(${JSON.stringify(moduleSpecifier)})[${JSON.stringify(claim.exportName)}];
type ${actual} = (typeof moduleImplementations)[${JSON.stringify(moduleSpecifier)}][${JSON.stringify(claim.exportName)}];
${comparison}`;
				})
				.join("\n\n");
			return `type ClaimedModule${moduleIndex}Exports = ${exportNames};
type Module${moduleIndex}ExportsCheck = Assert<
	IsExact<keyof (typeof moduleImplementations)[${JSON.stringify(moduleSpecifier)}], ClaimedModule${moduleIndex}Exports>
>;

${exportChecks}`;
		})
		.join("\n\n");
	const eventChecks = eventClaims
		.map(
			(
				claim,
				index,
			) => `type ExpectedEventContext${index} = ${claim.typeName}<unknown>;
type ActualEventContext${index} = ReturnType<
	(typeof eventContextFactories)[${JSON.stringify(claim.name)}]
>["context"];
type EventContextKeysCheck${index} = Assert<
	IsExact<keyof ActualEventContext${index}, keyof ExpectedEventContext${index}>
>;
declare const eventContext${index}: ActualEventContext${index};
const eventContextCompatibility${index}: ExpectedEventContext${index} = eventContext${index};`,
		)
		.join("\n\n");

	return `// Generated by cloudflare-conformance. Do not edit.
/// <reference path="./cloudflare-runtime.d.ts" />

import { bindingFactories } from "@open-orange/runtime-node/bindings";
import { eventContextFactories } from "@open-orange/runtime-node/events";
import { globalImplementations } from "@open-orange/runtime-node/globals";
import { moduleImplementations } from "@open-orange/runtime-node/modules";
import type {
	AlarmInvocationInfo as OrangeAlarmInvocationInfo,
	DurableObjectAbortOptions as OrangeDurableObjectAbortOptions,
	DurableObjectGetAlarmOptions as OrangeDurableObjectGetAlarmOptions,
	DurableObjectGetOptions as OrangeDurableObjectGetOptions,
	DurableObjectId as OrangeDurableObjectId,
	DurableObjectListOptions as OrangeDurableObjectListOptions,
	DurableObjectNamespace as OrangeDurableObjectNamespace,
	DurableObjectPutOptions as OrangeDurableObjectPutOptions,
	DurableObjectStorage as OrangeDurableObjectStorage,
	DurableObjectSetAlarmOptions as OrangeDurableObjectSetAlarmOptions,
	DurableObjectState as OrangeDurableObjectState,
	DurableObjectTransaction as OrangeDurableObjectTransaction,
	SqlStorage as OrangeSqlStorage,
	SqlStorageCursor as OrangeSqlStorageCursor,
	SqlStorageStatement as OrangeSqlStorageStatement,
	SqlStorageValue as OrangeSqlStorageValue,
	SyncKvListOptions as OrangeSyncKvListOptions,
	SyncKvStorage as OrangeSyncKvStorage,
	DurableObjectStub as OrangeDurableObjectStub,
} from "@open-orange/runtime-node/durable-objects";

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type IsExact<Left, Right> = IsAny<Left> extends true
	? IsAny<Right>
	: IsAny<Right> extends true
		? false
		: (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
			? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
				? true
				: false
			: false;
type Assert<Condition extends true> = Condition;
type DurableObjectIdCheck = Assert<IsExact<OrangeDurableObjectId, DurableObjectId>>;
type DurableObjectAbortOptionsCheck = Assert<
	IsExact<OrangeDurableObjectAbortOptions, DurableObjectAbortOptions>
>;
type AlarmInvocationInfoCheck = Assert<
	IsExact<OrangeAlarmInvocationInfo, AlarmInvocationInfo>
>;
type ImplementedDurableObjectStateNames =
	| "waitUntil"
	| "id"
	| "storage"
	| "blockConcurrencyWhile"
	| "acceptWebSocket"
	| "getWebSockets"
	| "setWebSocketAutoResponse"
	| "getWebSocketAutoResponse"
	| "getWebSocketAutoResponseTimestamp"
	| "setHibernatableWebSocketEventTimeout"
	| "getHibernatableWebSocketEventTimeout"
	| "getTags"
	| "abort";
type OrangeImplementedDurableObjectState = Pick<
	OrangeDurableObjectState<{ fixture: string }>,
	ImplementedDurableObjectStateNames
>;
type ExpectedImplementedDurableObjectState = Pick<
	DurableObjectState<{ fixture: string }>,
	ImplementedDurableObjectStateNames
>;
type ImplementedDurableObjectStateKeysCheck = Assert<
	IsExact<keyof OrangeImplementedDurableObjectState, keyof ExpectedImplementedDurableObjectState>
>;
declare const orangeImplementedDurableObjectState: OrangeImplementedDurableObjectState;
declare const expectedImplementedDurableObjectState: ExpectedImplementedDurableObjectState;
const expectedImplementedDurableObjectStateCompatibility: ExpectedImplementedDurableObjectState = orangeImplementedDurableObjectState;
const orangeImplementedDurableObjectStateCompatibility: OrangeImplementedDurableObjectState = expectedImplementedDurableObjectState;
type DurableObjectPropsCheck = Assert<
	IsExact<
		OrangeDurableObjectState<{ fixture: string }>["props"],
		DurableObjectState<{ fixture: string }>["props"]
	>
>;
type SqlStorageValueCheck = Assert<IsExact<OrangeSqlStorageValue, SqlStorageValue>>;
type OrangeSqlCursorInstance = OrangeSqlStorageCursor<Record<string, OrangeSqlStorageValue>>;
type ExpectedSqlCursorInstance = SqlStorageCursor<Record<string, SqlStorageValue>>;
type SqlStorageCursorKeysCheck = Assert<
	IsExact<keyof OrangeSqlCursorInstance, keyof ExpectedSqlCursorInstance>
>;
declare const orangeSqlCursor: OrangeSqlCursorInstance;
declare const expectedSqlCursor: ExpectedSqlCursorInstance;
const expectedSqlCursorCompatibility: ExpectedSqlCursorInstance = orangeSqlCursor;
const orangeSqlCursorCompatibility: OrangeSqlCursorInstance = expectedSqlCursor;
type SqlStorageKeysCheck = Assert<IsExact<keyof OrangeSqlStorage, keyof SqlStorage>>;
declare const orangeSqlStorage: OrangeSqlStorage;
declare const expectedSqlStorage: SqlStorage;
const expectedSqlStorageCompatibility: SqlStorage = orangeSqlStorage;
const orangeSqlStorageCompatibility: OrangeSqlStorage = expectedSqlStorage;
type SqlStorageStatementKeysCheck = Assert<
	IsExact<keyof OrangeSqlStorageStatement, keyof SqlStorageStatement>
>;
type DurableObjectStorageKeysCheck = Assert<
	IsExact<keyof OrangeDurableObjectStorage, keyof DurableObjectStorage>
>;
declare const orangeDurableObjectStorage: OrangeDurableObjectStorage;
declare const expectedDurableObjectStorage: DurableObjectStorage;
const expectedDurableObjectStorageCompatibility: DurableObjectStorage = orangeDurableObjectStorage;
const orangeDurableObjectStorageCompatibility: OrangeDurableObjectStorage = expectedDurableObjectStorage;
type OrangeTransactionSync = OrangeDurableObjectStorage["transactionSync"];
type ExpectedTransactionSync = DurableObjectStorage["transactionSync"];
declare const orangeTransactionSync: OrangeTransactionSync;
declare const expectedTransactionSync: ExpectedTransactionSync;
const expectedTransactionSyncCompatibility: ExpectedTransactionSync = orangeTransactionSync;
const orangeTransactionSyncCompatibility: OrangeTransactionSync = expectedTransactionSync;
type DurableObjectGetOptionsCheck = Assert<
	IsExact<OrangeDurableObjectGetOptions, DurableObjectGetOptions>
>;
type DurableObjectListOptionsCheck = Assert<
	IsExact<OrangeDurableObjectListOptions, DurableObjectListOptions>
>;
type DurableObjectPutOptionsCheck = Assert<
	IsExact<OrangeDurableObjectPutOptions, DurableObjectPutOptions>
>;
type AsyncKvMethodNames = "get" | "list" | "put" | "delete" | "deleteAll";
type OrangeAsyncKvStorage = Pick<OrangeDurableObjectStorage, AsyncKvMethodNames>;
type ExpectedAsyncKvStorage = Pick<DurableObjectStorage, AsyncKvMethodNames>;
type AsyncKvStorageCheck = Assert<
	IsExact<OrangeAsyncKvStorage, ExpectedAsyncKvStorage>
>;
declare const orangeAsyncKvStorage: OrangeAsyncKvStorage;
declare const expectedAsyncKvStorage: ExpectedAsyncKvStorage;
const expectedAsyncKvStorageCompatibility: ExpectedAsyncKvStorage = orangeAsyncKvStorage;
const orangeAsyncKvStorageCompatibility: OrangeAsyncKvStorage = expectedAsyncKvStorage;
type DurableObjectGetAlarmOptionsCheck = Assert<
	IsExact<OrangeDurableObjectGetAlarmOptions, DurableObjectGetAlarmOptions>
>;
type DurableObjectSetAlarmOptionsCheck = Assert<
	IsExact<OrangeDurableObjectSetAlarmOptions, DurableObjectSetAlarmOptions>
>;
type DurableObjectTransactionCheck = Assert<
	IsExact<OrangeDurableObjectTransaction, DurableObjectTransaction>
>;
declare const orangeDurableObjectTransaction: OrangeDurableObjectTransaction;
declare const expectedDurableObjectTransaction: DurableObjectTransaction;
const expectedDurableObjectTransactionCompatibility: DurableObjectTransaction = orangeDurableObjectTransaction;
const orangeDurableObjectTransactionCompatibility: OrangeDurableObjectTransaction = expectedDurableObjectTransaction;
type AsyncTransactionMethodNames =
	| "transaction"
	| "getAlarm"
	| "setAlarm"
	| "deleteAlarm"
	| "sync";
type OrangeAsyncTransactionStorage = Pick<
	OrangeDurableObjectStorage,
	AsyncTransactionMethodNames
>;
type ExpectedAsyncTransactionStorage = Pick<
	DurableObjectStorage,
	AsyncTransactionMethodNames
>;
type AsyncTransactionStorageCheck = Assert<
	IsExact<OrangeAsyncTransactionStorage, ExpectedAsyncTransactionStorage>
>;
declare const orangeAsyncTransactionStorage: OrangeAsyncTransactionStorage;
declare const expectedAsyncTransactionStorage: ExpectedAsyncTransactionStorage;
const expectedAsyncTransactionStorageCompatibility: ExpectedAsyncTransactionStorage = orangeAsyncTransactionStorage;
const orangeAsyncTransactionStorageCompatibility: OrangeAsyncTransactionStorage = expectedAsyncTransactionStorage;
type SyncKvListOptionsCheck = Assert<IsExact<OrangeSyncKvListOptions, SyncKvListOptions>>;
type SyncKvStorageKeysCheck = Assert<IsExact<keyof OrangeSyncKvStorage, keyof SyncKvStorage>>;
declare const orangeSyncKvStorage: OrangeSyncKvStorage;
declare const expectedSyncKvStorage: SyncKvStorage;
const expectedSyncKvStorageCompatibility: SyncKvStorage = orangeSyncKvStorage;
const orangeSyncKvStorageCompatibility: OrangeSyncKvStorage = expectedSyncKvStorage;
type OrangeDurableObjectNamespaceInstance = OrangeDurableObjectNamespace<undefined>;
type ExpectedDurableObjectNamespaceInstance = DurableObjectNamespace<undefined>;
type DurableObjectNamespaceIdSurfaceCheck = Assert<
	IsExact<
		Pick<OrangeDurableObjectNamespaceInstance, "idFromName" | "idFromString" | "newUniqueId">,
		Pick<ExpectedDurableObjectNamespaceInstance, "idFromName" | "idFromString" | "newUniqueId">
	>
>;
type DurableObjectNamespaceGetParametersCheck = Assert<
	IsExact<
		Parameters<OrangeDurableObjectNamespaceInstance["get"]>,
		Parameters<ExpectedDurableObjectNamespaceInstance["get"]>
	>
>;
type DurableObjectNamespaceGetByNameParametersCheck = Assert<
	IsExact<
		Parameters<OrangeDurableObjectNamespaceInstance["getByName"]>,
		Parameters<ExpectedDurableObjectNamespaceInstance["getByName"]>
	>
>;
type DurableObjectNamespaceJurisdictionParametersCheck = Assert<
	IsExact<
		Parameters<OrangeDurableObjectNamespaceInstance["jurisdiction"]>,
		Parameters<ExpectedDurableObjectNamespaceInstance["jurisdiction"]>
	>
>;
type DurableObjectStubIdentityCheck = Assert<
	IsExact<
		Pick<OrangeDurableObjectStub<undefined>, "id" | "name">,
		Pick<DurableObjectStub<undefined>, "id" | "name">
	>
>;
type DurableObjectStubFetchParametersCheck = Assert<
	IsExact<
		Parameters<OrangeDurableObjectStub<undefined>["fetch"]>,
		Parameters<DurableObjectStub<undefined>["fetch"]>
	>
>;
type DurableObjectStubFetchResultCheck = Assert<
	IsExact<
		ReturnType<OrangeDurableObjectStub<undefined>["fetch"]>,
		ReturnType<DurableObjectStub<undefined>["fetch"]>
	>
>;
interface DurableObjectRpcFixture extends Rpc.DurableObjectBranded {
	readonly summary: { count: number };
	add(amount: number): { count: number };
	greet(name: string): Promise<string>;
	stream(
		readable: ReadableStream<Uint8Array>,
		writable: WritableStream<Uint8Array>,
		request: Request,
	): Promise<Response>;
	alarm(): void;
}
type DurableObjectStubMethodCheck = Assert<
	IsExact<
		Pick<OrangeDurableObjectStub<DurableObjectRpcFixture>, "add" | "greet" | "summary">,
		Pick<DurableObjectStub<DurableObjectRpcFixture>, "add" | "greet" | "summary">
	>
>;
type OrangeDurableObjectStreamingMethod = OrangeDurableObjectStub<DurableObjectRpcFixture>["stream"];
type ExpectedDurableObjectStreamingMethod = DurableObjectStub<DurableObjectRpcFixture>["stream"];
type DurableObjectStreamingParametersCheck = Assert<
	IsExact<Parameters<OrangeDurableObjectStreamingMethod>, Parameters<ExpectedDurableObjectStreamingMethod>>
>;
type DurableObjectStreamingResultCheck = Assert<
	IsExact<Awaited<ReturnType<OrangeDurableObjectStreamingMethod>>, Awaited<ReturnType<ExpectedDurableObjectStreamingMethod>>>
>;
type DurableObjectStubReservedMethodCheck = Assert<
	IsExact<
		Extract<keyof OrangeDurableObjectStub<DurableObjectRpcFixture>, "alarm">,
		Extract<keyof DurableObjectStub<DurableObjectRpcFixture>, "alarm">
	>
>;
type ClaimedGlobalNames = ${claimedNames};
type GlobalRegistryKeysCheck = Assert<
	IsExact<keyof typeof globalImplementations, ClaimedGlobalNames>
>;
type ClaimedBindingNames = ${claimedBindingNames};
type BindingRegistryKeysCheck = Assert<
	IsExact<keyof typeof bindingFactories, ClaimedBindingNames>
>;
type ClaimedModuleSpecifiers = ${claimedModuleSpecifiers};
type ModuleRegistryKeysCheck = Assert<
	IsExact<keyof typeof moduleImplementations, ClaimedModuleSpecifiers>
>;
type ClaimedEventNames = ${claimedEventNames};
type EventRegistryKeysCheck = Assert<
	IsExact<keyof typeof eventContextFactories, ClaimedEventNames>
>;
${valueChecks.length === 0 ? "" : `\n${valueChecks}\n`}${bindingChecks.length === 0 ? "" : `\n${bindingChecks}\n`}${moduleChecks.length === 0 ? "" : `\n${moduleChecks}\n`}${eventChecks.length === 0 ? "" : `\n${eventChecks}\n`}`;
}

export async function writeGlobalTypeChecks(
	outputPath: string,
	support: unknown,
): Promise<void> {
	const names = claimedGlobalNames(support);
	await writeFile(
		outputPath,
		renderGlobalTypeChecks(
			names,
			partialGlobalNames(support),
			claimedBindings(support),
			claimedModuleExports(support),
			claimedEvents(support),
			absentGlobalMembers(support),
		),
		"utf8",
	);
}
