import { Buffer } from "node:buffer";

import { Headers } from "../../globals/http.js";
import { ReadableStream } from "../../globals/native.js";
import type { InternalObjectFetcher } from "../internal-objects.js";
import { assertFitsRivetCommit } from "../../internal/rivet-limits.js";
import { isRecord } from "../unknown-values.js";
import {
	decodeKvFrame,
	encodeKvFrame,
	type KvBulkEntry,
	type KvListedKey,
	type KvListRequest,
	type KvListResponse,
	type KvPutHead,
} from "./object.js";

// The KV namespace binding. It follows workerd's KV client for argument
// handling, result shapes, and error text, and Miniflare's local KV backend for
// the limits that the production service enforces.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/kv.c%2B%2B#L27-L44
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/kv/validator.worker.ts#L5-L170

// Cloudflare's KV quotas (512 B keys, 25 MiB values, 1 KiB metadata, 100 keys per bulk get,
// 1,000 keys per list, TTLs of at least 60 s) are not copied. Rivet's limits apply instead.
// A list page still holds 1,000 keys by default, as on Cloudflare.
const DEFAULT_LIST_KEYS = 1000;

type KvValueType = "arrayBuffer" | "json" | "stream" | "text";

export interface KvGetOptions {
	cacheTtl?: number;
	type?: string;
}

export interface KvPutOptions {
	expiration?: number;
	expirationTtl?: number;
	metadata?: unknown;
}

export interface KvListOptions {
	cursor?: string | null;
	limit?: number;
	prefix?: string | null;
}

export interface KvGetWithMetadataResult {
	cacheStatus: null;
	metadata: unknown;
	value: unknown;
}

export interface KvListResult {
	cacheStatus: null;
	cursor?: string;
	keys: { expiration?: number; metadata?: unknown; name: string }[];
	list_complete: boolean;
}

function kvError(method: string, status: number, message: string): Error {
	return new Error(`KV ${method} failed: ${status} ${message}`);
}

function validateKeyName(method: string, name: string): void {
	if (name === "") throw new TypeError("Key name cannot be empty.");
	if (name === ".") throw new TypeError('"." is not allowed as a key name.');
	if (name === "..") throw new TypeError('".." is not allowed as a key name.');
}

// The backend validates bulk keys, so its messages differ from single gets.
function validateBulkKey(name: string): void {
	if (name === "") throw kvError("GET_BULK", 400, "Key names must not be empty");
	if (name === "." || name === "..") {
		throw kvError("GET_BULK", 400, `Illegal key name "${name}". Please use a different name.`);
	}
}

function parseGetOptions(options: unknown): { cacheTtl?: number; type: string } {
	if (typeof options === "string") return { type: options };
	if (options === undefined || options === null) return { type: "text" };
	if (typeof options !== "object") throw new TypeError("KV get options must be a string or object");
	const type: unknown = Reflect.get(options, "type");
	const cacheTtl: unknown = Reflect.get(options, "cacheTtl");
	return {
		type: type === undefined ? "text" : String(type),
		...(cacheTtl === undefined ? {} : { cacheTtl: Math.trunc(Number(cacheTtl)) }),
	};
}

function validateCacheTtl(method: string, cacheTtl: number | undefined): void {
	if (cacheTtl !== undefined && (Number.isNaN(cacheTtl) || cacheTtl <= 0)) {
		throw kvError(method, 400, `Invalid cache_ttl of ${cacheTtl}. Please specify integer greater than 0.`);
	}
}

function isKvValueType(type: string): type is KvValueType {
	return type === "text" || type === "json" || type === "arrayBuffer" || type === "stream";
}

function decodeValue(bytes: Uint8Array, type: string): unknown {
	if (!isKvValueType(type)) {
		throw new TypeError(
			'Unknown response type. Possible types are "text", "arrayBuffer", "json", and "stream".',
		);
	}
	switch (type) {
		case "text":
			return new TextDecoder().decode(bytes);
		case "json":
			return JSON.parse(new TextDecoder().decode(bytes));
		case "arrayBuffer":
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		case "stream":
			return new ReadableStream<Uint8Array>({
				start(controller: ReadableStreamDefaultController<Uint8Array>) {
					if (bytes.byteLength > 0) controller.enqueue(bytes);
					controller.close();
				},
			});
	}
}

async function readStream(stream: ReadableStream<unknown>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) {
		if (!(chunk instanceof Uint8Array)) {
			throw new TypeError("KV put() stream values must produce Uint8Array chunks");
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

const invalidValueMessage =
	"KV put() accepts only strings, ArrayBuffers, ArrayBufferViews, and ReadableStreams as values.";

async function valueBytes(value: unknown): Promise<Uint8Array> {
	if (typeof value === "string") return new TextEncoder().encode(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
	}
	if (value instanceof ReadableStream) return await readStream(value);
	if ((typeof value === "object" && value !== null) || typeof value === "function") {
		throw new TypeError(invalidValueMessage);
	}
	// Workerd converts other primitives to strings.
	return new TextEncoder().encode(String(value));
}

// Miniflare resolves expiration and expirationTtl against the current second.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/kv/validator.worker.ts#L77-L132
function resolveExpiration(options: KvPutOptions | undefined): number | undefined {
	const now = Math.floor(Date.now() / 1000);
	if (options?.expirationTtl !== undefined) {
		const raw = String(options.expirationTtl);
		const ttl = Number.parseInt(raw, 10);
		if (Number.isNaN(ttl) || ttl <= 0) {
			throw kvError(
				"PUT",
				400,
				`Invalid expiration_ttl of ${raw}. Please specify integer greater than 0.`,
			);
		}
		return now + ttl;
	}
	if (options?.expiration !== undefined) {
		const raw = String(options.expiration);
		const expiration = Number.parseInt(raw, 10);
		if (Number.isNaN(expiration) || expiration <= now) {
			throw kvError(
				"PUT",
				400,
				`Invalid expiration of ${raw}. Please specify integer greater than the current number of seconds since the UNIX epoch.`,
			);
		}
		return expiration;
	}
	return undefined;
}

// The KV object's bulk-get body maps each requested key to an entry or null.
function bulkEntry(entries: unknown, name: string): KvBulkEntry | null {
	const entry = isRecord(entries) ? entries[name] : undefined;
	if (entry === undefined || entry === null) return null;
	if (
		isRecord(entry) &&
		typeof entry.value === "string" &&
		(entry.metadata === null || typeof entry.metadata === "string")
	) {
		return { metadata: entry.metadata, value: entry.value };
	}
	throw new Error("KV object returned an invalid bulk-get entry");
}

function isListedKey(value: unknown): value is KvListedKey {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		(value.expiration === undefined || typeof value.expiration === "number") &&
		(value.metadata === undefined || typeof value.metadata === "string")
	);
}

function parseListResponse(body: unknown): KvListResponse {
	if (isRecord(body)) {
		const { cursor, keys, list_complete } = body;
		if (
			(cursor === undefined || typeof cursor === "string") &&
			Array.isArray(keys) &&
			keys.every(isListedKey) &&
			typeof list_complete === "boolean"
		) {
			return { ...(cursor === undefined ? {} : { cursor }), keys, list_complete };
		}
	}
	throw new Error("KV object returned an invalid list body");
}

function parseJson(text: string): unknown {
	return JSON.parse(text);
}

async function checkResponse(method: string, response: Response): Promise<void> {
	if (response.status < 200 || response.status >= 300) {
		await response.body?.cancel();
		throw kvError(method, response.status, response.statusText);
	}
}

export class KVNamespace {
	readonly #fetcher: InternalObjectFetcher;

	constructor(fetcher: InternalObjectFetcher) {
		this.#fetcher = fetcher;
	}

	get(key: string | string[], options?: KvGetOptions | string): Promise<unknown> {
		return Array.isArray(key)
			? this.#getBulk(key, options, false)
			: this.#getSingle(String(key), options).then((result) => result.value);
	}

	getWithMetadata(
		key: string | string[],
		options?: KvGetOptions | string,
	): Promise<unknown> {
		return Array.isArray(key)
			? this.#getBulk(key, options, true)
			: this.#getSingle(String(key), options);
	}

	async #getSingle(
		key: string,
		rawOptions: unknown,
	): Promise<KvGetWithMetadataResult> {
		validateKeyName("GET", key);
		const options = parseGetOptions(rawOptions);
		validateCacheTtl("GET", options.cacheTtl);
		const response = await this.#fetcher.fetch("http://kv/get", { body: encodeKvFrame({ key }), method: "POST" });
		if (response.status === 404) {
			await response.body?.cancel();
			return { cacheStatus: null, metadata: null, value: null };
		}
		await checkResponse("GET", response);
		const frame = decodeKvFrame(new Uint8Array(await response.arrayBuffer()));
		const metadata = isRecord(frame.head) && typeof frame.head.metadata === "string" ? frame.head.metadata : null;
		const value = decodeValue(frame.value, options.type);
		return {
			cacheStatus: null,
			metadata: metadata === null ? null : parseJson(metadata),
			value,
		};
	}

	// Bulk reads support only text and JSON values and return a Map.
	// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/kv/namespace.worker.ts#L130-L185
	async #getBulk(
		keys: unknown[],
		rawOptions: unknown,
		withMetadata: boolean,
	): Promise<Map<string, unknown>> {
		const names = keys.map(String);
		const options = parseGetOptions(rawOptions);
		if (options.type !== "text" && options.type !== "json") {
			throw kvError(
				"GET_BULK",
				400,
				`"${options.type}" is not a valid type. Use "json" or "text"`,
			);
		}
		if (names.length < 1) {
			throw kvError("GET_BULK", 400, "You must request a minimum of 1 key");
		}
		for (const name of names) {
			validateBulkKey(name);
			validateCacheTtl("GET_BULK", options.cacheTtl);
		}
		const response = await this.#fetcher.fetch("http://kv/bulk-get", {
			body: JSON.stringify(names),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		await checkResponse("GET_BULK", response);
		const entries: unknown = await response.json();
		const result = new Map<string, unknown>();
		for (const name of names) {
			const entry = bulkEntry(entries, name);
			if (entry === null) {
				result.set(name, null);
				continue;
			}
			let value: unknown = entry.value;
			if (options.type === "json") {
				try {
					value = JSON.parse(entry.value);
				} catch {
					throw kvError(
						"GET_BULK",
						400,
						"At least one of the requested keys corresponds to a non-json value",
					);
				}
			}
			result.set(
				name,
				withMetadata
					? {
							metadata: entry.metadata === null ? null : parseJson(entry.metadata),
							value,
						}
					: value,
			);
		}
		return result;
	}

	async put(key: string, value: unknown, options?: KvPutOptions): Promise<void> {
		const name = String(key);
		validateKeyName("PUT", name);
		const expiration = resolveExpiration(options);
		const metadata = options?.metadata;
		const bytes = await valueBytes(value);
		const metadataJson = metadata === undefined || metadata === null ? null : JSON.stringify(metadata);
		assertFitsRivetCommit(
			"KV PUT: the key, value, and metadata together",
			Buffer.byteLength(name) + bytes.byteLength + (metadataJson === null ? 0 : Buffer.byteLength(metadataJson)),
		);
		const head: KvPutHead = {
			expiration: expiration ?? null,
			key: name,
			metadata: metadataJson,
		};
		const response = await this.#fetcher.fetch("http://kv/put", { body: encodeKvFrame(head, bytes), method: "POST" });
		await checkResponse("PUT", response);
	}

	async delete(key: string): Promise<void> {
		const name = String(key);
		validateKeyName("DELETE", name);
		const response = await this.#fetcher.fetch("http://kv/delete", { body: encodeKvFrame({ key: name }), method: "POST" });
		await checkResponse("DELETE", response);
	}

	async list(options?: KvListOptions): Promise<KvListResult> {
		let limit = DEFAULT_LIST_KEYS;
		if (options?.limit !== undefined && options.limit > 0) limit = Math.trunc(Number(options.limit));
		const request: KvListRequest = {
			cursor: options?.cursor ?? null,
			limit,
			prefix: options?.prefix ?? "",
		};
		const response = await this.#fetcher.fetch("http://kv/list", { body: encodeKvFrame(request), method: "POST" });
		await checkResponse("GET", response);
		const body = parseListResponse(await response.json());
		return {
			...body,
			cacheStatus: null,
			keys: body.keys.map((key) => ({
				name: key.name,
				...(key.expiration === undefined ? {} : { expiration: key.expiration }),
				...(key.metadata === undefined ? {} : { metadata: parseJson(key.metadata) }),
			})),
		};
	}
}
