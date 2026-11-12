import { Buffer } from "node:buffer";

import type { InternalObjectState } from "../internal-objects.js";
import { isRecord } from "../unknown-values.js";

// The KV backend: one internal Durable Object per namespace, holding entries in
// its SQLite storage. The client in ./namespace.ts validates every request
// first, so these routes only store and read. Expired entries read as absent,
// like Miniflare's KV storage.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/kv/namespace.worker.ts#L130-L338

// A request or response between the client and this object is one frame: a 4-byte big-endian
// length, that many bytes of JSON, then the value. Keys and metadata travel in the body, so URL
// and header size limits do not bound them.
export function encodeKvFrame(head: unknown, value: Uint8Array = new Uint8Array(0)): Uint8Array {
	const json = Buffer.from(JSON.stringify(head), "utf8");
	const frame = new Uint8Array(4 + json.byteLength + value.byteLength);
	new DataView(frame.buffer).setUint32(0, json.byteLength);
	frame.set(json, 4);
	frame.set(value, 4 + json.byteLength);
	return frame;
}

export function decodeKvFrame(frame: Uint8Array): { head: unknown; value: Uint8Array } {
	const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
	const head: unknown = JSON.parse(Buffer.from(frame.subarray(4, 4 + length)).toString("utf8"));
	return { head, value: frame.subarray(4 + length) };
}

export interface KvValueHead {
	expiration: number | null;
	metadata: string | null;
}

export interface KvPutHead extends KvValueHead {
	key: string;
}

export interface KvListRequest {
	cursor: string | null;
	limit: number;
	prefix: string;
}

export interface KvListedKey {
	expiration?: number;
	metadata?: string;
	name: string;
}

export interface KvListResponse {
	cursor?: string;
	keys: KvListedKey[];
	list_complete: boolean;
}

export interface KvBulkEntry {
	metadata: string | null;
	value: string;
}

type KvKeyRow = {
	expiration: number | null;
	key: string;
	metadata: string | null;
};

type KvRow = KvKeyRow & { value: ArrayBuffer };

function nowSeconds(): number {
	return Date.now() / 1000;
}

function encodeCursor(key: string): string {
	return Buffer.from(key, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
	return Buffer.from(cursor, "base64url").toString("utf8");
}

function requiredKey(head: unknown): string {
	const key = isRecord(head) ? head.key : undefined;
	if (typeof key !== "string") throw new TypeError("KV request is missing its key");
	return key;
}

async function readFrame(request: Request): Promise<{ head: unknown; value: Uint8Array }> {
	return decodeKvFrame(new Uint8Array(await request.arrayBuffer()));
}

export class KvNamespaceObject {
	readonly #state: InternalObjectState;
	#schemaReady = false;

	constructor(state: InternalObjectState) {
		this.#state = state;
	}

	#sql(): InternalObjectState["storage"]["sql"] {
		const sql = this.#state.storage.sql;
		if (!this.#schemaReady) {
			sql.exec(
				"CREATE TABLE IF NOT EXISTS openorange_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, expiration REAL, metadata TEXT) WITHOUT ROWID",
			);
			this.#schemaReady = true;
		}
		return sql;
	}

	#read(key: string): KvRow | undefined {
		const row = this.#sql()
			.exec<KvRow>(
				"SELECT key, value, expiration, metadata FROM openorange_kv WHERE key = ?",
				key,
			)
			.toArray()[0];
		if (row === undefined) return undefined;
		if (row.expiration !== null && row.expiration <= nowSeconds()) {
			this.#sql().exec("DELETE FROM openorange_kv WHERE key = ?", key);
			return undefined;
		}
		return row;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST") return new Response(null, { status: 405 });
		switch (url.pathname) {
			case "/get":
				return this.#get(requiredKey((await readFrame(request)).head));
			case "/bulk-get":
				return this.#getBulk(request);
			case "/put":
				return this.#put(await readFrame(request));
			case "/delete":
				this.#sql().exec("DELETE FROM openorange_kv WHERE key = ?", requiredKey((await readFrame(request)).head));
				return new Response(null, { status: 204 });
			case "/list":
				return this.#list((await readFrame(request)).head);
			default:
				return new Response(null, { status: 404 });
		}
	}

	#get(key: string): Response {
		const row = this.#read(key);
		if (row === undefined) return new Response(null, { status: 404 });
		const head: KvValueHead = {
			expiration: row.expiration === null ? null : Math.floor(row.expiration),
			metadata: row.metadata,
		};
		return new Response(encodeKvFrame(head, new Uint8Array(row.value)));
	}

	async #getBulk(request: Request): Promise<Response> {
		const keys: unknown = await request.json();
		if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
			throw new TypeError("KV bulk get requires an array of keys");
		}
		const decoder = new TextDecoder();
		const entries: Record<string, KvBulkEntry | null> = {};
		for (const key of keys) {
			const row = this.#read(key);
			entries[key] =
				row === undefined
					? null
					: { metadata: row.metadata, value: decoder.decode(row.value) };
		}
		return Response.json(entries);
	}

	#put({ head, value }: { head: unknown; value: Uint8Array }): Response {
		const key = requiredKey(head);
		const expiration = isRecord(head) && typeof head.expiration === "number" ? head.expiration : null;
		const metadata = isRecord(head) && typeof head.metadata === "string" ? head.metadata : null;
		this.#sql().exec(
			"INSERT OR REPLACE INTO openorange_kv (key, value, expiration, metadata) VALUES (?, ?, ?, ?)",
			key,
			value,
			expiration,
			metadata,
		);
		return new Response(null, { status: 204 });
	}

	// Keys list in UTF-8 byte order, which is SQLite's BINARY collation for
	// TEXT. The cursor is the last returned key.
	#list(head: unknown): Response {
		const options = isRecord(head) ? head : {};
		const limit = typeof options.limit === "number" ? options.limit : 1000;
		const prefix = typeof options.prefix === "string" ? options.prefix : "";
		const cursor = typeof options.cursor === "string" ? options.cursor : null;
		const after = cursor === null ? null : decodeCursor(cursor);
		const rows = this.#sql()
			.exec<KvKeyRow>(
				`SELECT key, expiration, metadata FROM openorange_kv
				WHERE key >= ?1 AND substr(key, 1, length(?1)) = ?1
					AND (?2 IS NULL OR key > ?2)
					AND (expiration IS NULL OR expiration > ?3)
				ORDER BY key LIMIT ?4`,
				prefix,
				after,
				nowSeconds(),
				limit + 1,
			)
			.toArray();
		const page = rows.slice(0, limit);
		const keys = page.map((row): KvListedKey => ({
			name: row.key,
			...(row.expiration === null ? {} : { expiration: Math.floor(row.expiration) }),
			...(row.metadata === null ? {} : { metadata: row.metadata }),
		}));
		const last = page.at(-1);
		const body: KvListResponse =
			rows.length > limit && last !== undefined
				? { cursor: encodeCursor(last.key), keys, list_complete: false }
				: { keys, list_complete: true };
		return Response.json(body);
	}
}
