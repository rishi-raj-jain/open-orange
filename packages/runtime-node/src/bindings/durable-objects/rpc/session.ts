import type { RivetWebSocket } from "../../../internal/rivetkit.js";
import {
	openCapnWebWebSocketClientSession,
	type CapnWebStub,
} from "./capnweb.js";
import {
	decodeRpcValue,
	disposeRpcValueExternals,
	encodeRpcValue,
	prepareThrownRpcError,
	restoreThrownRpcError,
	type RpcValueEnvelope,
} from "./codec.js";
import type {
	DurableObjectRpcContinuation,
	DurableObjectRpcContinuationStore,
} from "./continuations.js";
import {
	beginDurableObjectRpcHttpEnvelope,
	releaseDurableObjectRpcHttpContinuation,
	type DurableObjectRpcHttpCallOptions,
	type DurableObjectRpcHttpHandler,
} from "./http.js";
import { DurableObjectRpcTarget } from "./target.js";

export class DurableObjectRpcSessionTarget extends DurableObjectRpcTarget {
	readonly #continuation: DurableObjectRpcContinuation | undefined;
	readonly #continuations: DurableObjectRpcContinuationStore;
	readonly #handler: DurableObjectRpcHttpHandler;
	#claimed = false;

	constructor(
		handler: DurableObjectRpcHttpHandler,
		continuations: DurableObjectRpcContinuationStore,
		continuation?: DurableObjectRpcContinuation,
	) {
		super();
		this.#continuation = continuation;
		this.#continuations = continuations;
		this.#handler = handler;
	}

	async exchange(envelope: unknown): Promise<unknown> {
		try {
			return encodeRpcValue(await this.#handler(decodeRpcValue(envelope)));
		} catch (error) {
			throw prepareThrownRpcError(error);
		}
	}

	claim(): unknown {
		if (this.#continuation === undefined) {
			throw new Error("Durable Object RPC session has no continuation to claim");
		}
		const envelope = this.#continuations.claim(this.#continuation.token);
		this.#claimed = true;
		return envelope;
	}

	async releaseUnclaimed(): Promise<void> {
		if (this.#continuation !== undefined && !this.#claimed) {
			await this.#continuations.release(this.#continuation.token);
		}
	}
}

export class DurableObjectRpcWebSocketClient {
	readonly #session: CapnWebStub;
	#disposed = false;

	constructor(webSocket: RivetWebSocket) {
		this.#session = openCapnWebWebSocketClientSession(webSocket);
	}

	async exchange(value: unknown): Promise<unknown> {
		return this.exchangeEnvelope(encodeRpcValue(value));
	}

	async exchangeEnvelope(envelope: RpcValueEnvelope): Promise<unknown> {
		this.#requireOpen();
		const result = await this.#session.exchange(envelope);
		return decodeRpcValue(result);
	}

	async claim(): Promise<unknown> {
		this.#requireOpen();
		return decodeRpcValue(
			await this.#session.claim(),
		);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#session[Symbol.dispose]();
	}

	#requireOpen(): void {
		if (this.#disposed) {
			throw new Error("Durable Object RPC WebSocket session is disposed");
		}
	}
}

export interface DurableObjectRpcOpenedSession {
	release(): void | Promise<void>;
	readonly webSocket: RivetWebSocket;
}

export interface DurableObjectRpcSessionConnector {
	open(
		continuation?: DurableObjectRpcContinuation,
	): DurableObjectRpcOpenedSession | Promise<DurableObjectRpcOpenedSession>;
}

export interface DurableObjectRpcCallOptions
	extends DurableObjectRpcHttpCallOptions {
	readonly connector: DurableObjectRpcSessionConnector;
	// Stamped on errors that the Durable Object throws back to the caller.
	readonly durableObjectId?: string;
	readonly endpoint: string;
}

export interface DurableObjectRpcCallResult {
	dispose(): Promise<void>;
	readonly transport: "http" | "websocket";
	readonly value: unknown;
}

async function openSessionResult(
	connector: DurableObjectRpcSessionConnector,
	continuation: DurableObjectRpcContinuation | undefined,
	operation: (client: DurableObjectRpcWebSocketClient) => Promise<unknown>,
	signal: AbortSignal | undefined,
	onFailure: (() => Promise<void>) | undefined,
): Promise<DurableObjectRpcCallResult> {
	try {
		signal?.throwIfAborted();
	} catch (error) {
		if (onFailure !== undefined) await onFailure();
		throw error;
	}
	let opened: DurableObjectRpcOpenedSession;
	try {
		opened = await connector.open(continuation);
	} catch (error) {
		if (onFailure !== undefined) await onFailure();
		throw error;
	}
	let client: DurableObjectRpcWebSocketClient;
	try {
		client = new DurableObjectRpcWebSocketClient(opened.webSocket);
	} catch (error) {
		try {
			await opened.release();
		} finally {
			if (onFailure !== undefined) await onFailure();
		}
		throw error;
	}
	let removeAbortListener = (): void => undefined;
	try {
		signal?.throwIfAborted();
		const operationPromise = operation(client);
		const value = await (signal === undefined
			? operationPromise
			: Promise.race([
					operationPromise,
					new Promise<never>((_resolve, reject) => {
						const abort = (): void => reject(signal.reason);
						if (signal.aborted) abort();
						else {
							signal.addEventListener("abort", abort, { once: true });
							removeAbortListener = () =>
								signal.removeEventListener("abort", abort);
						}
					}),
				]));
		removeAbortListener();
		let disposed = false;
		return {
			async dispose(): Promise<void> {
				if (disposed) return;
				disposed = true;
				try {
					client.dispose();
				} finally {
					await opened.release();
				}
			},
			transport: "websocket",
			value,
		};
	} catch (error) {
		removeAbortListener();
		try {
			client.dispose();
		} finally {
			try {
				await opened.release();
			} finally {
				if (onFailure !== undefined) await onFailure();
			}
		}
		throw error;
	}
}

// An error that crossed RPC carries `remote: true`, and one from a Durable
// Object also carries the object's ID.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/js-rpc-test.js#L1899-L1921
function markRemoteError(error: unknown, durableObjectId: string | undefined): void {
	if (!(error instanceof Error)) return;
	restoreThrownRpcError(error);
	Reflect.set(error, "remote", true);
	if (durableObjectId !== undefined) Reflect.set(error, "durableObjectId", durableObjectId);
}

export async function callDurableObjectRpc(
	value: unknown,
	options: DurableObjectRpcCallOptions,
): Promise<DurableObjectRpcCallResult> {
	return await callEncodedDurableObjectRpc(encodeRpcValue(value), options);
}

/** Sends a value that the caller already encoded with `encodeRpcValue`. */
export async function callEncodedDurableObjectRpc(
	encoded: RpcValueEnvelope,
	options: DurableObjectRpcCallOptions,
): Promise<DurableObjectRpcCallResult> {
	try {
		return await callDurableObjectRpcEnvelope(encoded, options);
	} catch (error) {
		// An abort is the caller's own reason, not an error from the object.
		if (options.signal === undefined || error !== options.signal.reason) {
			markRemoteError(error, options.durableObjectId);
		}
		throw error;
	}
}

async function callDurableObjectRpcEnvelope(
	encoded: RpcValueEnvelope,
	options: DurableObjectRpcCallOptions,
): Promise<DurableObjectRpcCallResult> {
	if (encoded.externals.length !== 0) {
		return openSessionResult(
			options.connector,
			undefined,
			(client) => client.exchangeEnvelope(encoded),
			options.signal,
			() => disposeRpcValueExternals(encoded),
		);
	}
	const result = await beginDurableObjectRpcHttpEnvelope(
		options.endpoint,
		encoded,
		{
			fetch: options.fetch,
			signal: options.signal,
		},
	);
	if (result.kind === "session") {
		return openSessionResult(
			options.connector,
			result.continuation,
			(client) => client.claim(),
			options.signal,
			async () => {
				try {
					await releaseDurableObjectRpcHttpContinuation(
						options.endpoint,
						result.continuation,
						{ fetch: options.fetch },
					);
				} catch {
					// Expiry remains the final cleanup path if the actor is unreachable.
				}
			},
		);
	}
	return {
		dispose: async () => undefined,
		transport: "http",
		value: result.value,
	};
}
