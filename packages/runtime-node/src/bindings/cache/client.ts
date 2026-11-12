import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
	CacheBackend,
	CacheBodyRange,
	CacheEntryMetadata,
	CacheStoredEntry,
} from "../../globals/cache.js";
import type { InternalObjectFetcher } from "../internal-objects.js";
import { isRecord } from "../unknown-values.js";
import { cacheChunkSize, isHeaderPairs, type CacheCommitRequest } from "./object.js";

interface WebSocketLike {
	accept(): void;
	addEventListener(type: "close" | "error", listener: () => void): void;
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
	binaryType: string;
	close(code?: number): void;
	send(data: string): void;
}

function isWebSocketLike(value: unknown): value is WebSocketLike {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "accept") === "function" &&
		typeof Reflect.get(value, "addEventListener") === "function" &&
		typeof Reflect.get(value, "close") === "function" &&
		typeof Reflect.get(value, "send") === "function"
	);
}

// One WebSocket to the cache object that answers chunk reads in order.
interface ChunkReader {
	close(): void;
	read(blobId: string, index: number): Promise<Uint8Array>;
}

const bodyGoneMessage =
	"Cached response body is no longer available. Its entry was replaced or expired more than 5 minutes ago.";

// Chunk reads in flight per body stream.
const readAhead = 4;

async function expectOk(response: Response, operation: string): Promise<void> {
	if (response.ok) {
		await response.body?.cancel();
		return;
	}
	throw new Error(`Cache object ${operation} returned ${response.status}: ${await response.text()}`);
}

// Cuts a body into chunks of exactly `size` bytes, except the last.
async function* fixedChunks(
	body: AsyncIterable<Uint8Array>,
	size: number,
): AsyncIterable<Uint8Array> {
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

// The Worker-side half of the SQLite cache in ./object.ts.
export class CacheActorBackend implements CacheBackend {
	readonly #fetcher: InternalObjectFetcher;

	constructor(fetcher: InternalObjectFetcher) {
		this.#fetcher = fetcher;
	}

	#post(path: string, body: unknown): Promise<Response> {
		return this.#fetcher.fetch(`http://cache${path}`, {
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
	}

	async put(
		key: string,
		metadata: CacheEntryMetadata,
		body: AsyncIterable<Uint8Array>,
	): Promise<void> {
		const blobId = randomUUID();
		let index = 0;
		let size = 0;
		// Chunks of a failed upload are never committed, so garbage collection removes them.
		for await (const chunk of fixedChunks(body, cacheChunkSize)) {
			size += chunk.byteLength;
			await expectOk(
				await this.#fetcher.fetch(`http://cache/chunk?blob=${blobId}&idx=${index}`, {
					body: chunk,
					method: "PUT",
				}),
				"chunk write",
			);
			index += 1;
		}
		const commit: CacheCommitRequest = { ...metadata, blobId, key, size };
		const response = await this.#post("/commit", commit);
		if (response.status === 409) {
			await response.body?.cancel();
			throw new Error("Cache put failed: its body upload expired before it was committed.");
		}
		await expectOk(response, "commit");
	}

	async match(key: string): Promise<CacheStoredEntry | undefined> {
		const response = await this.#post("/match", { key });
		if (response.status === 404) {
			await response.body?.cancel();
			return undefined;
		}
		if (!response.ok) await expectOk(response, "match");
		const entry: unknown = await response.json();
		if (!isRecord(entry)) throw new Error("Cache object match returned a non-object body");
		const { blobId, headers, size, status } = entry;
		if (
			typeof blobId !== "string" ||
			!isHeaderPairs(headers) ||
			typeof size !== "number" ||
			typeof status !== "number"
		) {
			throw new Error("Cache object match returned an invalid entry");
		}
		return {
			headers,
			read: (range) => this.#readRange(blobId, size, range),
			size,
			status,
		};
	}

	async delete(key: string): Promise<boolean> {
		const response = await this.#post("/delete", { key });
		if (!response.ok) await expectOk(response, "delete");
		const body: unknown = await response.json();
		const deleted = isRecord(body) ? body.deleted : undefined;
		if (typeof deleted !== "boolean") {
			throw new Error("Cache object delete returned an invalid body");
		}
		return deleted;
	}

	// Streams the bytes of `range` by pulling whole chunks and trimming the
	// first and last.
	#readRange(blobId: string, size: number, range: CacheBodyRange): ReadableStream<Uint8Array> {
		const end = range.offset + range.length;
		const reads: { end: number; index: number; length: number; start: number }[] = [];
		for (
			let index = Math.floor(range.offset / cacheChunkSize);
			index * cacheChunkSize < end;
			index += 1
		) {
			const chunkStart = index * cacheChunkSize;
			reads.push({
				end: Math.min(end, chunkStart + cacheChunkSize) - chunkStart,
				index,
				length: Math.min(cacheChunkSize, size - chunkStart),
				start: Math.max(range.offset, chunkStart) - chunkStart,
			});
		}
		let next = 0;
		let reader: Promise<ChunkReader> | undefined;
		const pending: Promise<Uint8Array>[] = [];
		const fill = (): void => {
			while (pending.length < readAhead && next < reads.length) {
				const read = reads[next];
				next += 1;
				reader ??= this.#openChunkReader();
				const bytes = reader
					.then((open) => open.read(blobId, read.index))
					.then((chunk) => {
						if (chunk.byteLength !== read.length) {
							throw new Error(
								`Cache chunk read returned ${chunk.byteLength} of ${read.length} bytes`,
							);
						}
						return chunk.subarray(read.start, read.end);
					});
				// A cancelled body leaves prefetched reads unobserved.
				bytes.catch(() => undefined);
				pending.push(bytes);
			}
		};
		const close = async (): Promise<void> => {
			pending.length = 0;
			next = reads.length;
			(await reader?.catch(() => undefined))?.close();
		};
		// No high-water mark, so the stream pulls only for a read. A body that is never read, such
		// as the one of a match() that only checks for an entry, opens no chunk reader, whose
		// WebSocket would keep the cache object awake.
		return new ReadableStream<Uint8Array>(
			{
				async cancel(): Promise<void> {
					await close();
				},
				async pull(controller): Promise<void> {
					fill();
					const bytes = pending.shift();
					if (bytes === undefined) {
						await close();
						controller.close();
						return;
					}
					try {
						controller.enqueue(await bytes);
						fill();
					} catch (error: unknown) {
						await close();
						throw error;
					}
				},
			},
			{ highWaterMark: 0 },
		);
	}

	async #openChunkReader(): Promise<ChunkReader> {
		const response = await this.#fetcher.fetch("http://cache/chunks", {
			headers: { upgrade: "websocket" },
		});
		const socket: unknown = Reflect.get(response, "webSocket");
		if (!isWebSocketLike(socket)) {
			throw new Error(`Cache object refused the chunk reader with ${response.status}`);
		}
		socket.binaryType = "arraybuffer";
		socket.accept();
		const waiting: PromiseWithResolvers<Uint8Array>[] = [];
		let closed: Error | undefined;
		const fail = (error: Error): void => {
			closed ??= error;
			for (const read of waiting.splice(0)) read.reject(closed);
		};
		socket.addEventListener("message", (event: MessageEvent) => {
			const read = waiting.shift();
			if (read === undefined) return;
			if (typeof event.data === "string") read.reject(new Error(bodyGoneMessage));
			else if (event.data instanceof ArrayBuffer) read.resolve(new Uint8Array(event.data));
			else if (ArrayBuffer.isView(event.data)) {
				read.resolve(
					new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength),
				);
			} else read.reject(new Error("Cache chunk reader received an invalid chunk"));
		});
		socket.addEventListener("close", () => fail(new Error("Cache chunk reader closed")));
		socket.addEventListener("error", () => fail(new Error("Cache chunk reader failed")));
		return {
			close(): void {
				fail(new Error("Cache chunk reader closed"));
				socket.close(1000);
			},
			read(blobIdToRead: string, index: number): Promise<Uint8Array> {
				if (closed !== undefined) return Promise.reject(closed);
				const read = Promise.withResolvers<Uint8Array>();
				waiting.push(read);
				socket.send(JSON.stringify({ blob: blobIdToRead, idx: index }));
				return read.promise;
			},
		};
	}
}

// ORANGE_CACHE=off restores the workers.dev behaviour, where the Cache API
// stores nothing.
export function cacheEnabledFromEnvironment(environment: NodeJS.ProcessEnv): boolean {
	const value = environment.ORANGE_CACHE;
	if (value === undefined || value === "" || value === "on") return true;
	if (value === "off") return false;
	throw new Error(`ORANGE_CACHE must be "on" or "off", not ${JSON.stringify(value)}`);
}
