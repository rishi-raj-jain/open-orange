import { Buffer } from "node:buffer";

import { rivetEnvoyMessageBytes } from "../../../internal/rivet-limits.js";
import {
	invokeCapnWebHttpBatchMethod,
	invokeCapnWebHttpBatchResponse,
	invokeCapnWebInjectedHttpBatchMethod,
} from "./capnweb.js";
import {
	decodeRpcValue,
	encodeRpcValue,
	getRpcValueExternalCount,
	prepareThrownRpcError,
	type RpcValueEnvelope,
} from "./codec.js";
import type {
	DurableObjectRpcContinuation,
	DurableObjectRpcContinuationStore,
} from "./continuations.js";
import { DurableObjectRpcTarget } from "./target.js";

export type DurableObjectRpcHttpHandler = (
	value: unknown,
) => unknown | Promise<unknown>;

export interface DurableObjectRpcHttpCallOptions {
	readonly fetch?: (request: Request) => Response | Promise<Response>;
	readonly signal?: AbortSignal;
}

export interface DurableObjectRpcHttpTargetOptions {
	readonly continuations?: DurableObjectRpcContinuationStore;
}

export type DurableObjectRpcHttpResult =
	| {
			readonly kind: "session";
			readonly continuation: DurableObjectRpcContinuation;
	  }
	| {
			readonly kind: "value";
			readonly value: unknown;
	  };

type DurableObjectRpcHttpExchangeResult =
	| {
			readonly kind: "session";
			readonly continuation: DurableObjectRpcContinuation;
	  }
	| {
			readonly kind: "value";
			readonly envelope: RpcValueEnvelope;
	  };

export class DurableObjectRpcSessionRequiredError extends Error {
	readonly continuation: DurableObjectRpcContinuation | undefined;

	constructor(
		direction: "input" | "output",
		continuation?: DurableObjectRpcContinuation,
	) {
		super(
			`Durable Object RPC ${direction} contains live externals and requires a session`,
		);
		this.name = "DurableObjectRpcSessionRequiredError";
		this.continuation = continuation;
	}
}

export class DurableObjectRpcHttpTarget extends DurableObjectRpcTarget {
	readonly #continuations: DurableObjectRpcContinuationStore | undefined;
	readonly #handler: DurableObjectRpcHttpHandler;

	constructor(
		handler: DurableObjectRpcHttpHandler,
		options: DurableObjectRpcHttpTargetOptions = {},
	) {
		super();
		this.#continuations = options.continuations;
		this.#handler = handler;
	}

	async exchange(envelope: unknown): Promise<DurableObjectRpcHttpExchangeResult> {
		if (getRpcValueExternalCount(envelope) !== 0) {
			throw new DurableObjectRpcSessionRequiredError("input");
		}
		let encoded: RpcValueEnvelope;
		try {
			encoded = encodeRpcValue(await this.#handler(decodeRpcValue(envelope)));
		} catch (error) {
			throw prepareThrownRpcError(error);
		}
		if (encoded.externals.length !== 0) {
			if (this.#continuations === undefined) {
				throw new DurableObjectRpcSessionRequiredError("output");
			}
			return {
				continuation: this.#continuations.retain(encoded),
				kind: "session",
			};
		}
		return { envelope: encoded, kind: "value" };
	}

	async releaseContinuation(token: unknown): Promise<boolean> {
		if (typeof token !== "string" || token.length === 0) {
			throw new Error("Durable Object RPC continuation token is invalid");
		}
		if (this.#continuations === undefined) return false;
		return this.#continuations.release(token);
	}
}

function decodeContinuation(value: unknown): DurableObjectRpcContinuation {
	if (typeof value !== "object" || value === null) {
		throw new Error("Durable Object RPC returned an invalid continuation");
	}
	const token: unknown = Reflect.get(value, "token");
	const expiresAt: unknown = Reflect.get(value, "expiresAt");
	if (
		typeof token !== "string" ||
		token.length === 0 ||
		typeof expiresAt !== "number" ||
		!Number.isFinite(expiresAt)
	) {
		throw new Error("Durable Object RPC returned an invalid continuation");
	}
	return { expiresAt, token };
}

function decodeHttpExchangeResult(value: unknown): DurableObjectRpcHttpResult {
	if (typeof value !== "object" || value === null) {
		throw new Error("Durable Object RPC returned an invalid HTTP result");
	}
	const kind: unknown = Reflect.get(value, "kind");
	if (kind === "value") {
		return { kind, value: decodeRpcValue(Reflect.get(value, "envelope")) };
	}
	if (kind === "session") {
		return {
			continuation: decodeContinuation(Reflect.get(value, "continuation")),
			kind,
		};
	}
	throw new Error("Durable Object RPC returned an invalid HTTP result");
}

// A Durable Object RPC call is one message to the Engine, with binary data in base64. A call over
// the Engine's message limit would fail with a bare 500, so it fails here with the limit instead.

function assertFitsRivetMessage(body: string): void {
	const bytes = Buffer.byteLength(body, "utf8");
	if (bytes <= rivetEnvoyMessageBytes) return;
	throw new RangeError(
		`This Durable Object RPC call is ${bytes} bytes on the wire. Rivet's Engine takes at most ${rivetEnvoyMessageBytes} bytes (32 MiB) in one message, and binary data counts 4/3 of its size. Send large data with stub.fetch(), which streams it.`,
	);
}

async function invokeHttpRpcMethod(
	endpoint: string,
	methodName: string,
	args: readonly unknown[],
	options: DurableObjectRpcHttpCallOptions,
): Promise<unknown> {
	options.signal?.throwIfAborted();
	const request = new Request(endpoint, { signal: options.signal });
	const injectedFetch = options.fetch;
	if (injectedFetch === undefined) {
		return invokeCapnWebHttpBatchMethod(request, methodName, args);
	}
	return invokeCapnWebInjectedHttpBatchMethod(
		async (body) => {
			assertFitsRivetMessage(body);
			const response = await injectedFetch(
				new Request(request, { body, method: "POST" }),
			);
			if (!response.ok) {
				await response.body?.cancel();
				// The `group.code` that Rivet sets on a rejection names the cause, such as storage
				// that is unavailable, so the caller's error keeps it.
				const code = response.headers.get("x-rivet-error");
				throw new Error(
					`RPC request failed: ${response.status} ${response.statusText}${code === null ? "" : ` (${code})`}`,
				);
			}
			const responseBody = await response.text();
			return responseBody === "" ? [] : responseBody.split("\n");
		},
		methodName,
		args,
	);
}

export async function beginDurableObjectRpcHttp(
	endpoint: string,
	value: unknown,
	options: DurableObjectRpcHttpCallOptions = {},
): Promise<DurableObjectRpcHttpResult> {
	options.signal?.throwIfAborted();
	const encoded = encodeRpcValue(value);
	return beginDurableObjectRpcHttpEnvelope(endpoint, encoded, options);
}

export async function beginDurableObjectRpcHttpEnvelope(
	endpoint: string,
	encoded: RpcValueEnvelope,
	options: DurableObjectRpcHttpCallOptions = {},
): Promise<DurableObjectRpcHttpResult> {
	if (encoded.externals.length !== 0) {
		throw new DurableObjectRpcSessionRequiredError("input");
	}
	return decodeHttpExchangeResult(
		await invokeHttpRpcMethod(endpoint, "exchange", [encoded], options),
	);
}

export async function callDurableObjectRpcHttp(
	endpoint: string,
	value: unknown,
	options: DurableObjectRpcHttpCallOptions = {},
): Promise<unknown> {
	const result = await beginDurableObjectRpcHttp(endpoint, value, options);
	if (result.kind === "session") {
		throw new DurableObjectRpcSessionRequiredError(
			"output",
			result.continuation,
		);
	}
	return result.value;
}

export async function releaseDurableObjectRpcHttpContinuation(
	endpoint: string,
	continuation: DurableObjectRpcContinuation,
	options: DurableObjectRpcHttpCallOptions = {},
): Promise<boolean> {
	const released = await invokeHttpRpcMethod(
		endpoint,
		"releaseContinuation",
		[continuation.token],
		options,
	);
	if (typeof released !== "boolean") {
		throw new Error("Durable Object RPC returned an invalid release result");
	}
	return released;
}

// Cap'n Web schedules one Fetch request for the queued batch and the server
// drains every promise produced by that batch before returning the response.
// https://github.com/cloudflare/capnweb/blob/7702075d4122e6808512ee50acc591310b77da7a/src/batch.ts#L80-L169

export function handleDurableObjectRpcHttp(
	request: Request,
	target: DurableObjectRpcTarget,
): Promise<Response> {
	return invokeCapnWebHttpBatchResponse(request, target);
}

// The adapter delegates exactly one already-routed Fetch request to Cap'n Web;
// it does not create or own an HTTP server or actor lifecycle.
// https://github.com/cloudflare/capnweb/blob/7702075d4122e6808512ee50acc591310b77da7a/src/batch.ts#L134-L169
