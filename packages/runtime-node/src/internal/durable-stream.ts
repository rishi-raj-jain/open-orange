import { createHash } from "node:crypto";

import type { RivetActorClient, RivetActorHandle } from "./rivetkit.js";

// Rivet Durable Streams, which Rivet Services hosts in the envoy pool `services`. Each stream is
// one `durableStream` actor. Orange calls the actor through the Engine gateway, the way the
// Services HTTP facade does, so it needs no port of the facade and works from every node of a
// cluster.
// https://github.com/rivet-dev/durable-streams/blob/09fcd92/src/facade.rs#L72-L269
export const durableStreamActorName = "durableStream";

const tenantScope = "default";
// The actor reads each protocol header from `x-rivet-ds-h-<name>` as base64url.
// https://github.com/rivet-dev/durable-streams/blob/09fcd92/src/protocol.rs#L16
const headerPrefix = "x-rivet-ds-h-";
// The protocol's limit on one append body.
// https://github.com/rivet-dev/durable-streams/blob/09fcd92/src/protocol.rs#L9
export const durableStreamMaxAppendBytes = 1_000_000;

export interface DurableStreamProducer {
	readonly id: string;
	seq: number;
}

export interface DurableStreamRead {
	readonly items: readonly unknown[];
	readonly nextOffset: string;
}

/** The actor key that the Services facade uses for a stream path, so both reach one stream. */
export function durableStreamActorKey(path: string): string {
	return createHash("sha256").update(tenantScope).update(Buffer.from([0])).update(canonicalPath(path)).digest("hex");
}

// The facade canonicalizes paths with a leading slash.
function canonicalPath(path: string): string {
	return `/${path.replace(/^\/+/, "")}`;
}

function bridgedHeaders(headers: Readonly<Record<string, string>>): Headers {
	const bridged = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		bridged.set(`${headerPrefix}${name}`, Buffer.from(value).toString("base64url"));
	}
	return bridged;
}

async function failure(operation: string, path: string, response: Response): Promise<Error> {
	return new Error(
		`Durable Streams ${operation} on ${path} failed with status ${response.status}: ${await response.text()}`,
	);
}

/** A JSON stream of Rivet Durable Streams. A call on a stream that does not exist returns `undefined`. */
export class DurableJsonStream {
	readonly #client: RivetActorClient;
	readonly #handle: RivetActorHandle;
	readonly #path: string;

	constructor(client: RivetActorClient, path: string) {
		this.#client = client;
		this.#path = canonicalPath(path);
		this.#handle = client.getOrCreate(durableStreamActorName, [durableStreamActorKey(this.#path)], {
			path: this.#path,
			tenant_scope: tenantScope,
		});
	}

	get path(): string {
		return this.#path;
	}

	async #call(
		method: string,
		query: string,
		headers: Readonly<Record<string, string>>,
		body?: string,
		signal?: AbortSignal,
	): Promise<Response> {
		const url = `http://actor/protocol${query.length === 0 ? "" : `?${query}`}`;
		const response = this.#handle.fetch(
			new Request(url, {
				...(body === undefined ? {} : { body }),
				headers: bridgedHeaders(headers),
				method,
				...(signal === undefined ? {} : { signal }),
			}),
		);
		if (signal === undefined) return await response;
		// A call to a stream whose Services process is gone waits for the Engine to move the stream,
		// and an aborted signal does not end it. The caller stops waiting at once, for example so an
		// actor that shuts down is not held for its whole grace period.
		signal.throwIfAborted();
		const aborted = Promise.withResolvers<never>();
		const onAbort = (): void => aborted.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([response, aborted.promise]);
		} catch (error: unknown) {
			if (signal.aborted) void response.then((late) => late.body?.cancel(), () => undefined);
			throw error;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	/**
	 * Creates the stream, which the store deletes at `expiresAt`. Creating an existing stream with
	 * the same settings succeeds.
	 */
	async create(expiresAt: Date): Promise<void> {
		const response = await this.#call(
			"PUT",
			"",
			{ "content-type": "application/json", "stream-expires-at": expiresAt.toISOString() },
			"[]",
		);
		if (!response.ok) throw await failure("create", this.#path, response);
		await response.body?.cancel();
	}

	/** Whether the stream's actor exists, without creating it. A deleted stream can keep its actor. */
	async exists(): Promise<boolean> {
		return await this.#client.exists(durableStreamActorName, [durableStreamActorKey(this.#path)]);
	}

	async delete(): Promise<void> {
		const response = await this.#call("DELETE", "", {});
		if (!response.ok && response.status !== 404) throw await failure("delete", this.#path, response);
		await response.body?.cancel();
	}

	/**
	 * Appends each JSON-encoded item as one record. The stream drops an append whose producer seq
	 * it already has, so a retry after a lost response does not write the items twice.
	 */
	async append(encodedItems: readonly string[], producer: DurableStreamProducer): Promise<"appended" | undefined> {
		const response = await this.#call(
			"POST",
			"",
			{
				"content-type": "application/json",
				"producer-epoch": "0",
				"producer-id": producer.id,
				"producer-seq": String(producer.seq),
			},
			`[${encodedItems.join(",")}]`,
		);
		if (response.status === 404) {
			await response.body?.cancel();
			return undefined;
		}
		if (!response.ok) throw await failure("append", this.#path, response);
		await response.body?.cancel();
		return "appended";
	}

	/**
	 * Reads the records after `offset` (`-1` is the start). With `wait`, an empty read waits up to
	 * the stream's long-poll timeout for new records.
	 */
	async read(offset: string, wait: boolean, signal?: AbortSignal): Promise<DurableStreamRead | undefined> {
		const query = `offset=${encodeURIComponent(offset)}${wait ? "&live=long-poll" : ""}`;
		const response = await this.#call("GET", query, {}, undefined, signal);
		if (response.status === 404) {
			await response.body?.cancel();
			return undefined;
		}
		if (!response.ok) throw await failure("read", this.#path, response);
		const nextOffset = response.headers.get("stream-next-offset") ?? offset;
		// A long-poll that times out has no body.
		if (response.status === 204) return { items: [], nextOffset };
		const items: unknown = await response.json();
		if (!Array.isArray(items)) throw new TypeError(`Durable Streams read on ${this.#path} returned no array`);
		return { items, nextOffset };
	}
}
