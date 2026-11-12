import { Buffer } from "node:buffer";

import { bodyChunkBytes } from "../../globals/http.js";
import { Blob } from "../../globals/native.js";
import {
	r2HashAlgorithms,
	r2Limits,
	type R2Backend,
	type R2Body,
	type R2Checksums,
	type R2ListPage,
	type R2WriteMetadata,
} from "./backend.js";
import { parseConditional, parseHttpMetadata, parseRange } from "./conditional.js";
import {
	isR2StorageError,
	notSupported,
	R2StorageError,
	runtimeError,
	type R2Action,
} from "./errors.js";
import { R2MultipartUpload, type R2MultipartContext } from "./multipart.js";
import { R2Object, R2ObjectBody } from "./object.js";
import { isObject } from "../unknown-values.js";

// The R2 bucket binding. It mirrors workerd's R2Bucket client for argument
// handling, result shapes, and error text, and Miniflare's R2 validator for
// the limits the R2 service enforces. Storage is a pluggable backend.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/r2-bucket.c%2B%2B#L464-L1238
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/r2/validator.worker.ts#L108-L220

export interface R2Objects {
	cursor?: string;
	delimitedPrefixes: string[];
	objects: R2Object[];
	truncated: boolean;
}

const hashLengths: Readonly<Record<keyof R2Checksums, number>> = {
	md5: 16,
	sha1: 20,
	sha256: 32,
	sha384: 48,
	sha512: 64,
};

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
	return isObject(value) && typeof Reflect.get(value, "getReader") === "function";
}

function validateKey(key: string): void {
	if (Buffer.byteLength(key) > r2Limits.maxKeySize) throw R2StorageError.of("InvalidObjectName");
}

// R2 counts a string's length twice when it has a character above U+00FF.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/r2/validator.worker.ts#L98-L106
function serialisedLength(value: string): number {
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) >= 256) return value.length * 2;
	}
	return value.length;
}

function parseCustomMetadata(value: unknown): Record<string, string> | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isObject(value)) throw new TypeError("customMetadata must be an object");
	const metadata: Record<string, string> = {};
	let size = 0;
	for (const [name, entry] of Object.entries(value)) {
		metadata[name] = String(entry);
		size += serialisedLength(name) + serialisedLength(metadata[name]);
	}
	if (size > r2Limits.maxMetadataSize) throw R2StorageError.of("MetadataTooLarge");
	return metadata;
}

// Reads the one checksum a put may carry, as lowercase hex.
function parseExpectedChecksum(options: Record<string, unknown>): R2Checksums {
	const expected: R2Checksums = {};
	for (const { field, label } of r2HashAlgorithms) {
		const value = options[field];
		if (value === undefined) continue;
		if (Object.keys(expected).length > 0) {
			throw new TypeError("You cannot specify multiple hashing algorithms.");
		}
		const bytes = hashLengths[field];
		if (typeof value === "string") {
			if (value.length !== bytes * 2) {
				throw new TypeError(`${label} is ${bytes * 2} hex characters, not ${value.length}`);
			}
			if (!/^[0-9a-f]*$/i.test(value)) {
				throw new TypeError(`Provided ${label} wasn't a valid hex string`);
			}
			expected[field] = value.toLowerCase();
		} else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
			const view =
				value instanceof ArrayBuffer
					? new Uint8Array(value)
					: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
			if (view.byteLength !== bytes) {
				throw new TypeError(`${label} is ${bytes} bytes, not ${view.byteLength}`);
			}
			expected[field] = Buffer.from(view).toString("hex");
		} else {
			throw new TypeError(`${label} must be a string or a buffer`);
		}
	}
	return expected;
}

async function* streamBytes(stream: ReadableStream<unknown>): AsyncIterable<Uint8Array> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			yield bodyChunkBytes(value);
		}
	} finally {
		// Cancelling also releases the stream when a write stops early.
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

async function putValue(value: unknown): Promise<R2Body> {
	if (value === null || value === undefined) return new Uint8Array();
	if (typeof value === "string") return new TextEncoder().encode(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
	}
	if (value instanceof Blob || value instanceof globalThis.Blob) {
		return new Uint8Array(await value.arrayBuffer());
	}
	if (isReadableStream(value)) return streamBytes(value);
	throw new TypeError(
		"R2 put() accepts only nulls, strings, Blobs, ArrayBuffers, ArrayBufferViews, and ReadableStreams as values.",
	);
}

function writeMetadata(options: Record<string, unknown>): R2WriteMetadata {
	const httpMetadata = parseHttpMetadata(options.httpMetadata);
	const customMetadata = parseCustomMetadata(options.customMetadata);
	return {
		...(customMetadata === undefined ? {} : { customMetadata }),
		...(httpMetadata === undefined ? {} : { httpMetadata }),
		...(options.storageClass === undefined ? {} : { storageClass: String(options.storageClass) }),
	};
}

function isIterable(value: unknown): value is Iterable<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		Symbol.iterator in value &&
		typeof value[Symbol.iterator] === "function"
	);
}

function iterable(value: unknown): Iterable<unknown> {
	if (!isIterable(value)) throw new TypeError(`${String(value)} is not iterable`);
	return value;
}

export class R2Bucket {
	readonly #backend: R2Backend;
	readonly #context: R2MultipartContext;

	constructor(backend: R2Backend) {
		this.#backend = backend;
		this.#context = {
			backend,
			putValue,
			run: (action, key, operation) => this.#run(action, key, operation),
			unsupportedSsecKey: (action, options) => this.#unsupportedSsecKey(action, options),
		};
	}

	// Validates the key, runs a backend call, and gives a storage error the
	// action prefix that workerd adds.
	async #run<T>(action: R2Action, key: string | undefined, operation: () => Promise<T>): Promise<T> {
		try {
			if (key !== undefined) validateKey(key);
			return await operation();
		} catch (error: unknown) {
			if (isR2StorageError(error)) throw runtimeError(action, error);
			throw error;
		}
	}

	#unsupportedSsecKey(action: R2Action, options: unknown): void {
		if (isObject(options) && options.ssecKey !== undefined) {
			throw notSupported(action, "ssecKey (customer-provided encryption keys)");
		}
	}

	async head(key: string): Promise<R2Object | null> {
		const name = String(key);
		const stored = await this.#run("head", name, () => this.#backend.head(name));
		return stored === null ? null : new R2Object(stored, { length: stored.size, offset: 0 });
	}

	async get(key: string, options?: unknown): Promise<R2ObjectBody | R2Object | null> {
		const name = String(key);
		const record = isObject(options) ? options : {};
		const onlyIf = parseConditional(record.onlyIf);
		const range = parseRange(record.range);
		this.#unsupportedSsecKey("get", options);
		const result = await this.#run("get", name, () => this.#backend.get(name, onlyIf, range));
		if (result === null) return null;
		if (!result.passed) {
			return new R2Object(result.object, { length: result.object.size, offset: 0 });
		}
		return new R2ObjectBody(result.object, result.body, result.range);
	}

	async put(key: string, value: unknown, options?: unknown): Promise<R2Object | null> {
		const name = String(key);
		const record = isObject(options) ? options : {};
		const onlyIf = parseConditional(record.onlyIf);
		const expected = parseExpectedChecksum(record);
		this.#unsupportedSsecKey("put", options);
		const stored = await this.#run("put", name, async () => {
			const metadata = writeMetadata(record);
			const body = await putValue(value);
			return await this.#backend.put(name, body, {
				...metadata,
				expected,
				...(onlyIf === undefined ? {} : { onlyIf }),
			});
		});
		return stored === null ? null : new R2Object(stored);
	}

	async delete(keys: string | string[]): Promise<void> {
		const names = Array.isArray(keys) ? keys.map(String) : [String(keys)];
		await this.#run("delete", undefined, async () => {
			for (const name of names) validateKey(name);
			await this.#backend.delete(names);
		});
	}

	async list(options?: unknown): Promise<R2Objects> {
		const record = isObject(options) ? options : {};
		const include = record.include === undefined ? [] : [...iterable(record.include)];
		for (const field of include) {
			if (field !== "httpMetadata" && field !== "customMetadata") {
				throw new RangeError(`Unsupported include value ${String(field)}`);
			}
		}
		const optional = (name: string): string | undefined =>
			record[name] === undefined || record[name] === null ? undefined : String(record[name]);
		const page: R2ListPage = await this.#run("list", undefined, async () => {
			const limit = record.limit === undefined ? r2Limits.maxListKeys : Math.trunc(Number(record.limit));
			if (!(limit >= 1 && limit <= r2Limits.maxListKeys)) throw R2StorageError.of("InvalidMaxKeys");
			const cursor = optional("cursor");
			const delimiter = optional("delimiter");
			const startAfter = optional("startAfter");
			return await this.#backend.list({
				includeCustomMetadata: include.includes("customMetadata"),
				includeHttpMetadata: include.includes("httpMetadata"),
				limit,
				prefix: optional("prefix") ?? "",
				...(cursor === undefined ? {} : { cursor }),
				...(delimiter === undefined ? {} : { delimiter }),
				...(startAfter === undefined ? {} : { startAfter }),
			});
		});
		const objects = page.objects.map((stored) => new R2Object(stored));
		return page.truncated && page.cursor !== undefined
			? {
					cursor: page.cursor,
					delimitedPrefixes: page.delimitedPrefixes,
					objects,
					truncated: true,
				}
			: { delimitedPrefixes: page.delimitedPrefixes, objects, truncated: false };
	}

	async createMultipartUpload(key: string, options?: unknown): Promise<R2MultipartUpload> {
		const name = String(key);
		const record = isObject(options) ? options : {};
		this.#unsupportedSsecKey("createMultipartUpload", options);
		const uploadId = await this.#run("createMultipartUpload", name, () =>
			this.#backend.createMultipartUpload(name, writeMetadata(record)),
		);
		return new R2MultipartUpload(name, uploadId, this.#context);
	}

	resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
		return new R2MultipartUpload(String(key), String(uploadId), this.#context);
	}
}
