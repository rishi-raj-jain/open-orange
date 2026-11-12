import { Buffer } from "node:buffer";
import { createHash, type Hash } from "node:crypto";

import { ReadableStream } from "../../globals/native.js";
import type { R2Conditional, R2HttpFields, R2RangeRequest, R2ResolvedRange } from "./conditional.js";
import { badDigest, R2StorageError } from "./errors.js";

// The storage interface behind an R2 bucket binding. The bucket client in
// ./bucket.ts validates arguments and builds the runtime objects; a backend
// only stores and reads. Two backends implement it: ./actor-backend.ts (the
// default, chunked blobs in an internal Rivet Actor's SQLite) and
// ./s3-backend.ts (an opt-in S3-compatible store).

// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/r2/constants.ts#L1-L9
export const r2Limits = {
	maxKeySize: 1024,
	maxListKeys: 1000,
	maxMetadataSize: 2048,
	maxValueSize: 5_368_709_120 - 5_242_880,
	minMultipartPartSize: 5 * 1024 * 1024,
} as const;

export const r2HashAlgorithms = [
	{ field: "md5", label: "MD5", node: "md5" },
	{ field: "sha1", label: "SHA-1", node: "sha1" },
	{ field: "sha256", label: "SHA-256", node: "sha256" },
	{ field: "sha384", label: "SHA-384", node: "sha384" },
	{ field: "sha512", label: "SHA-512", node: "sha512" },
] as const;

export type R2HashField = (typeof r2HashAlgorithms)[number]["field"];

// Lowercase hex digests.
export type R2Checksums = Partial<Record<R2HashField, string>>;

// JSON-safe object metadata, shared by both backends and the bucket actor.
export interface R2StoredObject {
	checksums: R2Checksums;
	customMetadata?: Record<string, string>;
	etag: string;
	httpMetadata?: R2HttpFields;
	key: string;
	size: number;
	storageClass: string;
	// Milliseconds since the Unix epoch.
	uploaded: number;
	version: string;
}

export interface R2WriteMetadata {
	customMetadata?: Record<string, string>;
	httpMetadata?: R2HttpFields;
	storageClass?: string;
}

export interface R2PutRequest extends R2WriteMetadata {
	// The checksum the caller supplied, if any. R2 accepts at most one.
	expected: R2Checksums;
	onlyIf?: R2Conditional;
}

export type R2GetResult =
	| { object: R2StoredObject; passed: false }
	| {
			body: ReadableStream<Uint8Array>;
			object: R2StoredObject;
			passed: true;
			range: R2ResolvedRange;
	  };

export interface R2ListRequest {
	cursor?: string;
	delimiter?: string;
	includeCustomMetadata: boolean;
	includeHttpMetadata: boolean;
	limit: number;
	prefix: string;
	startAfter?: string;
}

export interface R2ListPage {
	cursor?: string;
	delimitedPrefixes: string[];
	objects: R2StoredObject[];
	truncated: boolean;
}

export interface R2UploadedPart {
	etag: string;
	partNumber: number;
}

// A put value after the bucket normalized it: bytes it already holds, or a
// stream it reads once.
export type R2Body = Uint8Array | AsyncIterable<Uint8Array>;

export interface R2Backend {
	abortMultipartUpload(key: string, uploadId: string): Promise<void>;
	completeMultipartUpload(
		key: string,
		uploadId: string,
		parts: R2UploadedPart[],
	): Promise<R2StoredObject>;
	createMultipartUpload(key: string, metadata: R2WriteMetadata): Promise<string>;
	delete(keys: string[]): Promise<void>;
	// Returns null when the key is missing. A failed `onlyIf` returns the
	// object without a body.
	get(
		key: string,
		onlyIf: R2Conditional | undefined,
		range: R2RangeRequest | undefined,
	): Promise<R2GetResult | null>;
	head(key: string): Promise<R2StoredObject | null>;
	list(request: R2ListRequest): Promise<R2ListPage>;
	// Returns null when `onlyIf` fails.
	put(key: string, body: R2Body, request: R2PutRequest): Promise<R2StoredObject | null>;
	// Returns the part's ETag.
	uploadPart(key: string, uploadId: string, partNumber: number, body: R2Body): Promise<string>;
}

// Computes the digests a write needs while its bytes stream past, and tracks
// the size so an oversized upload fails before it is stored.
export class R2Digests {
	readonly #hashes: [R2HashField, Hash][];
	#size = 0;

	constructor(fields: Iterable<R2HashField>) {
		this.#hashes = [...new Set(fields)].map((field) => [
			field,
			createHash(r2HashAlgorithms.find((algorithm) => algorithm.field === field)?.node ?? field),
		]);
	}

	get size(): number {
		return this.#size;
	}

	update(bytes: Uint8Array): void {
		this.#size += bytes.byteLength;
		if (this.#size > r2Limits.maxValueSize) throw R2StorageError.of("EntityTooLarge");
		for (const [, hash] of this.#hashes) hash.update(bytes);
	}

	digest(): R2Checksums {
		const checksums: R2Checksums = {};
		for (const [field, hash] of this.#hashes) checksums[field] = hash.digest("hex");
		return checksums;
	}
}

// Throws R2's BadDigest error when a supplied checksum does not match.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/r2/validator.worker.ts#L109-L129
export function verifyChecksums(expected: R2Checksums, actual: R2Checksums): R2Checksums {
	const verified: R2Checksums = {};
	for (const { field, label } of r2HashAlgorithms) {
		const provided = expected[field];
		if (provided === undefined) continue;
		const computed = actual[field];
		if (computed !== provided) throw badDigest(label, provided, computed ?? "");
		verified[field] = computed;
	}
	return verified;
}

// Re-cuts a body into chunks of exactly `size` bytes, except the last.
export async function* fixedChunks(body: R2Body, size: number): AsyncIterable<Uint8Array> {
	if (body instanceof Uint8Array) {
		for (let offset = 0; offset < body.byteLength; offset += size) {
			yield body.subarray(offset, offset + size);
		}
		return;
	}
	let pending: Uint8Array[] = [];
	let pendingSize = 0;
	for await (const piece of body) {
		let rest = piece;
		while (rest.byteLength > 0) {
			const take = Math.min(size - pendingSize, rest.byteLength);
			pending.push(rest.subarray(0, take));
			pendingSize += take;
			rest = rest.subarray(take);
			if (pendingSize === size) {
				yield Buffer.concat(pending, size);
				pending = [];
				pendingSize = 0;
			}
		}
	}
	if (pendingSize > 0) yield Buffer.concat(pending, pendingSize);
}

// A body stream that pulls one piece at a time from `next` until it returns
// undefined.
export function pullStream(
	next: () => Promise<Uint8Array | undefined>,
	cancel: () => Promise<void> | void = () => undefined,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async cancel(): Promise<void> {
			await cancel();
		},
		async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
			const piece = await next();
			if (piece === undefined) controller.close();
			else controller.enqueue(piece);
		},
	});
}
