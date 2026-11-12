import { randomUUID } from "node:crypto";

import type { InternalObjectFetcher } from "../internal-objects.js";
import {
	fixedChunks,
	pullStream,
	R2Digests,
	verifyChecksums,
	type R2Backend,
	type R2Body,
	type R2GetResult,
	type R2ListPage,
	type R2ListRequest,
	type R2PutRequest,
	type R2StoredObject,
	type R2UploadedPart,
	type R2WriteMetadata,
} from "./backend.js";
import {
	conditionPasses,
	resolveRange,
	type R2Conditional,
	type R2RangeRequest,
	type R2ResolvedRange,
} from "./conditional.js";
import { R2StorageError } from "./errors.js";

interface WebSocketLike {
	accept(): void;
	addEventListener(type: "close" | "error", listener: () => void): void;
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
	binaryType: string;
	close(code?: number): void;
	send(data: string): void;
}
import {
	r2ChunkSize,
	type R2BlobSegment,
	type R2CommitRequest,
	type R2PartRequest,
} from "./storage.js";
import {
	parseR2ErrorBody,
	parseR2GetResponse,
	parseR2ListPage,
	parseR2ObjectResponse,
	parseR2StringField,
	r2ExpectedHashFields,
} from "./wire.js";

// Chunk uploads in flight per write. Each chunk is one actor request and one
// SQLite commit, so a few in flight hide the round trip.
const uploadConcurrency = 4;
// Chunk reads in flight per body stream.
const readAhead = 4;

const bodyGoneMessage =
	"R2 object body is no longer available. It was overwritten or deleted more than 5 minutes ago.";

// One WebSocket to the bucket object that answers chunk reads in order.
interface ChunkReader {
	close(): void;
	read(blobId: string, index: number): Promise<Uint8Array>;
}

async function failure(response: Response): Promise<never> {
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {}
	const body = parseR2ErrorBody(parsed);
	if (body !== undefined) throw new R2StorageError(body.error.code, body.error.message);
	throw new Error(`R2 bucket object returned ${response.status}: ${text}`);
}

async function json(response: Response): Promise<unknown> {
	if (!response.ok) return await failure(response);
	return await response.json();
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

interface StoredBlob {
	blobId: string;
	checksums: ReturnType<R2Digests["digest"]>;
	size: number;
}

// The client half of the SQLite backend in ./storage.ts. It streams bodies
// in and out one chunk per request.
export class R2ActorBackend implements R2Backend {
	readonly #fetcher: InternalObjectFetcher;

	constructor(fetcher: InternalObjectFetcher) {
		this.#fetcher = fetcher;
	}

	#post(path: string, body: unknown): Promise<Response> {
		return this.#fetcher.fetch(`http://r2${path}`, {
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
	}

	// Writes a body as a new, uncommitted blob and returns its digests.
	async #writeBlob(body: R2Body, digests: R2Digests): Promise<StoredBlob> {
		const blobId = randomUUID();
		const inFlight = new Set<Promise<void>>();
		let failed: unknown;
		let index = 0;
		for await (const chunk of fixedChunks(body, r2ChunkSize)) {
			digests.update(chunk);
			const upload = this.#fetcher
				.fetch(`http://r2/chunk?blob=${blobId}&idx=${index}`, { body: chunk, method: "PUT" })
				.then(async (response) => {
					if (!response.ok) await failure(response);
				})
				.catch((error: unknown) => {
					failed ??= error;
				})
				.finally(() => inFlight.delete(upload));
			inFlight.add(upload);
			index += 1;
			if (inFlight.size >= uploadConcurrency) await Promise.race(inFlight);
			if (failed !== undefined) break;
		}
		await Promise.all(inFlight);
		if (failed !== undefined) throw failed;
		return { blobId, checksums: digests.digest(), size: digests.size };
	}

	async head(key: string): Promise<R2StoredObject | null> {
		const response = await this.#post("/head", { key });
		if (response.status === 404) return null;
		return parseR2ObjectResponse(await json(response));
	}

	async get(
		key: string,
		onlyIf: R2Conditional | undefined,
		rangeRequest: R2RangeRequest | undefined,
	): Promise<R2GetResult | null> {
		const response = await this.#post("/get", { key });
		if (response.status === 404) return null;
		const { object, segments } = parseR2GetResponse(await json(response));
		if (onlyIf !== undefined && !conditionPasses(onlyIf, object)) {
			return { object, passed: false };
		}
		const range = resolveRange(rangeRequest, object.size);
		return { body: this.#readRange(segments, range), object, passed: true, range };
	}

	// Streams the bytes of `range` by pulling whole chunks and trimming the
	// first and last.
	#readRange(segments: R2BlobSegment[], range: R2ResolvedRange): ReturnType<typeof pullStream> {
		const reads: { blobId: string; end: number; index: number; length: number; start: number }[] =
			[];
		const rangeEnd = range.offset + range.length;
		let segmentStart = 0;
		for (const segment of segments) {
			const segmentEnd = segmentStart + segment.size;
			const from = Math.max(range.offset, segmentStart) - segmentStart;
			const to = Math.min(rangeEnd, segmentEnd) - segmentStart;
			segmentStart = segmentEnd;
			if (to <= from) continue;
			for (let index = Math.floor(from / r2ChunkSize); index * r2ChunkSize < to; index += 1) {
				const chunkStart = index * r2ChunkSize;
				reads.push({
					blobId: segment.blobId,
					end: Math.min(to, chunkStart + r2ChunkSize) - chunkStart,
					index,
					length: Math.min(r2ChunkSize, segment.size - chunkStart),
					start: Math.max(from, chunkStart) - chunkStart,
				});
			}
		}
		let next = 0;
		let reader: Promise<ChunkReader> | undefined;
		const pending: Promise<Uint8Array>[] = [];
		const fill = (): void => {
			while (pending.length < readAhead && next < reads.length) {
				const read = reads[next];
				if (read === undefined) break;
				next += 1;
				reader ??= this.#openChunkReader();
				const bytes = reader
					.then((open) => open.read(read.blobId, read.index))
					.then((chunk) => {
						if (chunk.byteLength !== read.length) {
							throw new Error(`R2 chunk read returned ${chunk.byteLength} of ${read.length} bytes`);
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
		return pullStream(async () => {
			fill();
			const bytes = pending.shift();
			if (bytes === undefined) {
				await close();
				return undefined;
			}
			try {
				const chunk = await bytes;
				fill();
				return chunk;
			} catch (error: unknown) {
				await close();
				throw error;
			}
		}, close);
	}

	async #openChunkReader(): Promise<ChunkReader> {
		const response = await this.#fetcher.fetch("http://r2/chunks", {
			headers: { upgrade: "websocket" },
		});
		const socket: unknown = Reflect.get(response, "webSocket");
		if (!isWebSocketLike(socket)) {
			throw new Error(`R2 bucket object refused the chunk reader with ${response.status}`);
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
			} else read.reject(new Error("R2 chunk reader received an invalid chunk"));
		});
		socket.addEventListener("close", () => fail(new Error("R2 chunk reader closed")));
		socket.addEventListener("error", () => fail(new Error("R2 chunk reader failed")));
		return {
			close(): void {
				fail(new Error("R2 chunk reader closed"));
				socket.close(1000);
			},
			read(blobId: string, index: number): Promise<Uint8Array> {
				if (closed !== undefined) return Promise.reject(closed);
				const read = Promise.withResolvers<Uint8Array>();
				waiting.push(read);
				socket.send(JSON.stringify({ blob: blobId, idx: index }));
				return read.promise;
			},
		};
	}

	async put(key: string, body: R2Body, request: R2PutRequest): Promise<R2StoredObject | null> {
		const blob = await this.#writeBlob(
			body,
			new R2Digests(["md5", ...r2ExpectedHashFields(request.expected)]),
		);
		const checksums = verifyChecksums(request.expected, blob.checksums);
		const md5 = blob.checksums.md5 ?? "";
		const commit: R2CommitRequest = {
			blobId: blob.blobId,
			checksums,
			etag: md5,
			key,
			size: blob.size,
			...(request.customMetadata === undefined ? {} : { customMetadata: request.customMetadata }),
			...(request.httpMetadata === undefined ? {} : { httpMetadata: request.httpMetadata }),
			...(request.onlyIf === undefined ? {} : { onlyIf: request.onlyIf }),
			...(request.storageClass === undefined ? {} : { storageClass: request.storageClass }),
		};
		const response = await this.#post("/put", commit);
		if (response.status === 412) {
			await response.body?.cancel();
			return null;
		}
		return parseR2ObjectResponse(await json(response));
	}

	async delete(keys: string[]): Promise<void> {
		const response = await this.#post("/delete", { keys });
		if (!response.ok) await failure(response);
		await response.body?.cancel();
	}

	async list(request: R2ListRequest): Promise<R2ListPage> {
		return parseR2ListPage(await json(await this.#post("/list", request)));
	}

	async createMultipartUpload(key: string, metadata: R2WriteMetadata): Promise<string> {
		const response = await this.#post("/multipart/create", { key, ...metadata });
		return parseR2StringField(await json(response), "uploadId");
	}

	async uploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		body: R2Body,
	): Promise<string> {
		const blob = await this.#writeBlob(body, new R2Digests(["md5"]));
		const part: R2PartRequest = {
			blobId: blob.blobId,
			key,
			md5: blob.checksums.md5 ?? "",
			partNumber,
			size: blob.size,
			uploadId,
		};
		return parseR2StringField(await json(await this.#post("/multipart/part", part)), "etag");
	}

	async completeMultipartUpload(
		key: string,
		uploadId: string,
		parts: R2UploadedPart[],
	): Promise<R2StoredObject> {
		const response = await this.#post("/multipart/complete", { key, parts, uploadId });
		return parseR2ObjectResponse(await json(response));
	}

	async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
		const response = await this.#post("/multipart/abort", { key, uploadId });
		if (!response.ok) await failure(response);
		await response.body?.cancel();
	}
}
