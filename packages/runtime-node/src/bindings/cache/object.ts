import type { CacheEntryMetadata } from "../../globals/cache.js";
import { Response as OrangeResponse } from "../../globals/http.js";
import { WebSocketPair } from "../../globals/websocket.js";
import type { InternalObjectState } from "../internal-objects.js";

// The Cache API backend: one internal Durable Object (a Rivet Actor) per
// cache name, holding entries and bodies in its SQLite storage. It plays the
// part of Miniflare's cache object. The Worker-side code in
// ../../globals/cache.ts decides what is storable and shapes match responses,
// so these routes only store, expire, and read.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/cache/cache.worker.ts#L271-L401
//
// Bodies are stored like R2 bodies: the client writes 512 KiB chunks under a
// fresh blob id, one request each, and a commit points the entry at the blob.
// A reader always streams the one blob that its match returned, and a
// replaced blob stays readable for gcDelayMs, so a concurrent put never
// produces a torn body. Chunks are read over a WebSocket, because the pinned
// RivetKit can cut a streamed actor HTTP response.

export const cacheChunkSize = 512 * 1024;

// Unreferenced blobs wait this long before garbage collection, so an upload
// in progress and a read of a replaced entry keep their chunks.
const gcDelayMs = 5 * 60 * 1000;
// Chunks and expired entries removed per alarm run, which keeps commits small.
const gcBudget = 16;

export interface CacheObjectState extends InternalObjectState {
	readonly storage: InternalObjectState["storage"] & {
		getAlarm(): Promise<number | null>;
		setAlarm(scheduledTime: number): Promise<void>;
	};
}

export interface CacheCommitRequest extends CacheEntryMetadata {
	blobId: string;
	key: string;
	size: number;
}

export interface CacheMatchResponse extends CacheEntryMetadata {
	blobId: string;
	size: number;
}

type EntryRow = {
	blob_id: string;
	expires_at: number;
	headers: string;
	size: number;
	status: number;
};

const schema = [
	`CREATE TABLE IF NOT EXISTS entries (
		key TEXT PRIMARY KEY,
		blob_id TEXT NOT NULL,
		status INTEGER NOT NULL,
		headers TEXT NOT NULL,
		size INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS entries_expires_at ON entries (expires_at)",
	`CREATE TABLE IF NOT EXISTS blob_chunks (
		blob_id TEXT NOT NULL,
		idx INTEGER NOT NULL,
		bytes BLOB NOT NULL,
		PRIMARY KEY (blob_id, idx)
	)`,
	// touched_at is the last chunk write or the time the blob lost its entry.
	`CREATE TABLE IF NOT EXISTS pending_blobs (
		blob_id TEXT PRIMARY KEY,
		touched_at INTEGER NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS pending_blobs_touched_at ON pending_blobs (touched_at)",
];

function requiredParameter(url: URL, name: string): string {
	const value = url.searchParams.get(name);
	if (value === null) throw new TypeError(`Cache request is missing ${name}`);
	return value;
}

export function isHeaderPairs(value: unknown): value is [string, string][] {
	return (
		Array.isArray(value) &&
		value.every(
			(pair: unknown) =>
				Array.isArray(pair) &&
				pair.length === 2 &&
				typeof pair[0] === "string" &&
				typeof pair[1] === "string",
		)
	);
}

function parseCommitRequest(body: unknown): CacheCommitRequest {
	if (typeof body !== "object" || body === null) {
		throw new TypeError("Cache commit request must be an object");
	}
	const blobId: unknown = Reflect.get(body, "blobId");
	const expiresAt: unknown = Reflect.get(body, "expiresAt");
	const headers: unknown = Reflect.get(body, "headers");
	const key: unknown = Reflect.get(body, "key");
	const size: unknown = Reflect.get(body, "size");
	const status: unknown = Reflect.get(body, "status");
	if (
		typeof blobId !== "string" ||
		typeof expiresAt !== "number" ||
		!isHeaderPairs(headers) ||
		typeof key !== "string" ||
		typeof size !== "number" ||
		typeof status !== "number"
	) {
		throw new TypeError("Cache commit request has invalid fields");
	}
	return { blobId, expiresAt, headers, key, size, status };
}

function parseChunkRequest(data: unknown): { blob: unknown; idx: unknown } {
	const message: unknown = JSON.parse(String(data));
	if (typeof message !== "object" || message === null) {
		throw new TypeError("Cache chunk request must be an object");
	}
	return { blob: Reflect.get(message, "blob"), idx: Reflect.get(message, "idx") };
}

function requiredKey(body: unknown): string {
	const key: unknown = Reflect.get(Object(body), "key");
	if (typeof key !== "string") throw new TypeError("Cache request is missing its key");
	return key;
}

export class CacheObject {
	readonly #state: CacheObjectState;
	#schemaReady = false;
	// The alarm time this object last set or read, so most writes skip getAlarm().
	#alarmAt: number | null | undefined;

	constructor(state: CacheObjectState) {
		this.#state = state;
	}

	#sql(): InternalObjectState["storage"]["sql"] {
		const sql = this.#state.storage.sql;
		if (!this.#schemaReady) {
			for (const statement of schema) sql.exec(statement);
			this.#schemaReady = true;
		}
		return sql;
	}

	#transaction<T>(closure: () => T): T {
		this.#sql();
		return this.#state.storage.transactionSync(closure);
	}

	async fetch(request: Request): Promise<Response | OrangeResponse> {
		const url = new URL(request.url);
		switch (`${request.method} ${url.pathname}`) {
			case "PUT /chunk":
				return await this.#putChunk(request, url);
			case "GET /chunks":
				return this.#chunkReader(request);
			case "POST /commit":
				return await this.#commit(parseCommitRequest(await request.json()));
			case "POST /match":
				return await this.#match(requiredKey(await request.json()));
			case "POST /delete":
				return await this.#delete(requiredKey(await request.json()));
			default:
				return new Response(null, { status: 404 });
		}
	}

	async #putChunk(request: Request, url: URL): Promise<Response> {
		const blobId = requiredParameter(url, "blob");
		const index = Number(requiredParameter(url, "idx"));
		const bytes = new Uint8Array(await request.arrayBuffer());
		this.#transaction(() => {
			this.#sql().exec(
				"INSERT OR REPLACE INTO blob_chunks (blob_id, idx, bytes) VALUES (?, ?, ?)",
				blobId,
				index,
				bytes,
			);
			this.#markPending(blobId);
		});
		await this.#scheduleAlarm();
		return new Response(null, { status: 204 });
	}

	// Answers each `{ blob, idx }` text message, in order, with the chunk as a
	// binary message, or with the text "missing" when the chunk is gone.
	#chunkReader(request: Request): Response | OrangeResponse {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response(null, { status: 426 });
		}
		const pair = new WebSocketPair();
		const server = pair[1];
		server.accept();
		server.addEventListener("message", (event: MessageEvent) => {
			const { blob, idx } = parseChunkRequest(event.data);
			const row = this.#sql()
				.exec<{ bytes: ArrayBuffer }>(
					"SELECT bytes FROM blob_chunks WHERE blob_id = ? AND idx = ?",
					blob,
					idx,
				)
				.toArray()[0];
			server.send(row === undefined ? "missing" : row.bytes);
		});
		server.addEventListener("close", () => server.close());
		return new OrangeResponse(null, { status: 101, webSocket: pair[0] });
	}

	#markPending(blobId: string): void {
		this.#sql().exec(
			"INSERT INTO pending_blobs (blob_id, touched_at) VALUES (?, ?) ON CONFLICT (blob_id) DO UPDATE SET touched_at = excluded.touched_at",
			blobId,
			Date.now(),
		);
	}

	// Removes an entry and hands its blob to garbage collection. Returns the
	// removed row.
	#removeEntry(key: string): EntryRow | undefined {
		const row = this.#sql()
			.exec<EntryRow>(
				"DELETE FROM entries WHERE key = ? RETURNING blob_id, expires_at, headers, size, status",
				key,
			)
			.toArray()[0];
		if (row !== undefined) this.#markPending(row.blob_id);
		return row;
	}

	async #commit(request: CacheCommitRequest): Promise<Response> {
		const committed = this.#transaction((): boolean => {
			// A blob whose chunks were collected after a long upload pause is
			// incomplete. The entry is dropped instead of serving a short body.
			const stored = this.#sql()
				.exec<{ count: number; total: number }>(
					"SELECT count(*) AS count, coalesce(sum(length(bytes)), 0) AS total FROM blob_chunks WHERE blob_id = ?",
					request.blobId,
				)
				.toArray()[0];
			if (
				stored?.count !== Math.ceil(request.size / cacheChunkSize) ||
				stored.total !== request.size
			) {
				return false;
			}
			this.#removeEntry(request.key);
			this.#sql().exec("DELETE FROM pending_blobs WHERE blob_id = ?", request.blobId);
			this.#sql().exec(
				"INSERT INTO entries (key, blob_id, status, headers, size, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
				request.key,
				request.blobId,
				request.status,
				JSON.stringify(request.headers),
				request.size,
				request.expiresAt,
			);
			return true;
		});
		await this.#scheduleAlarm();
		return new Response(null, { status: committed ? 204 : 409 });
	}

	async #match(key: string): Promise<Response> {
		const row = this.#sql()
			.exec<EntryRow>(
				"SELECT blob_id, expires_at, headers, size, status FROM entries WHERE key = ?",
				key,
			)
			.toArray()[0];
		if (row === undefined) return new Response(null, { status: 404 });
		if (row.expires_at <= Date.now()) {
			this.#transaction(() => this.#removeEntry(key));
			await this.#scheduleAlarm();
			return new Response(null, { status: 404 });
		}
		const headers: unknown = JSON.parse(row.headers);
		if (!isHeaderPairs(headers)) throw new TypeError("Cached entry headers are invalid");
		const body: CacheMatchResponse = {
			blobId: row.blob_id,
			expiresAt: row.expires_at,
			headers,
			size: row.size,
			status: row.status,
		};
		return Response.json(body);
	}

	async #delete(key: string): Promise<Response> {
		const row = this.#transaction(() => this.#removeEntry(key));
		if (row !== undefined) await this.#scheduleAlarm();
		// An expired entry was already a miss, so deleting it reports false.
		return Response.json({ deleted: row !== undefined && row.expires_at > Date.now() });
	}

	// The next time garbage collection has work: a pending blob passing its
	// delay, or an entry expiring.
	#nextWork(): number | undefined {
		// An aggregate query returns one row, with null for an empty table.
		const row = this.#sql()
			.exec<{ blob: number | null; entry: number | null }>(
				"SELECT (SELECT min(touched_at) FROM pending_blobs) AS blob, (SELECT min(expires_at) FROM entries) AS entry",
			)
			.one();
		const times: number[] = [];
		if (row.blob !== null) times.push(row.blob + gcDelayMs);
		if (row.entry !== null) times.push(row.entry);
		return times.length === 0 ? undefined : Math.min(...times);
	}

	async #scheduleAlarm(): Promise<void> {
		const next = this.#nextWork();
		if (next === undefined) return;
		this.#alarmAt ??= await this.#state.storage.getAlarm();
		if (this.#alarmAt !== null && this.#alarmAt <= next) return;
		await this.#state.storage.setAlarm(next);
		this.#alarmAt = next;
	}

	// Drops expired entries, then deletes the chunks of blobs that stayed
	// unreferenced for gcDelayMs: replaced, deleted, and expired entries, and
	// abandoned or oversized uploads.
	async alarm(): Promise<void> {
		this.#alarmAt = null;
		const now = Date.now();
		this.#transaction(() => {
			const expired = this.#sql()
				.exec<{ key: string }>(
					"SELECT key FROM entries WHERE expires_at <= ? ORDER BY expires_at LIMIT ?",
					now,
					gcBudget,
				)
				.toArray();
			for (const { key } of expired) this.#removeEntry(key);
		});
		const cutoff = now - gcDelayMs;
		let budget = gcBudget;
		const collectable = this.#sql()
			.exec<{ blob_id: string }>(
				"SELECT blob_id FROM pending_blobs WHERE touched_at <= ? ORDER BY touched_at LIMIT ?",
				cutoff,
				gcBudget,
			)
			.toArray();
		for (const { blob_id: blobId } of collectable) {
			if (budget <= 0) break;
			this.#transaction(() => {
				const deleted = this.#sql()
					.exec<{ idx: number }>(
						"DELETE FROM blob_chunks WHERE blob_id = ? AND idx IN (SELECT idx FROM blob_chunks WHERE blob_id = ? ORDER BY idx LIMIT ?) RETURNING idx",
						blobId,
						blobId,
						budget,
					)
					.toArray();
				budget -= deleted.length;
				const remaining = this.#sql()
					.exec<{ found: number }>(
						"SELECT EXISTS (SELECT 1 FROM blob_chunks WHERE blob_id = ?) AS found",
						blobId,
					)
					.toArray()[0];
				if (remaining?.found !== 1) {
					this.#sql().exec(
						"DELETE FROM pending_blobs WHERE blob_id = ? AND touched_at <= ?",
						blobId,
						cutoff,
					);
				}
			});
		}
		const next = this.#nextWork();
		if (next !== undefined) {
			const at = Math.max(next, Date.now() + 1000);
			await this.#state.storage.setAlarm(at);
			this.#alarmAt = at;
		}
	}
}
