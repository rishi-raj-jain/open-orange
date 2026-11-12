import { readerOf, withInternalWriter } from "../../../internal/stream-methods.js";
import type { RpcValueExternalKind } from "./codec.js";
import { DurableObjectRpcTarget } from "./target.js";

const localExternalValue = Symbol("OpenOrangeLocalRpcExternalValue");

interface PreparedReadableTransport {
	readonly cancelTarget: ReadableCancelTarget;
	dispose(): Promise<void>;
	readonly readable: ReadableStream<Uint8Array>;
}

class OutgoingReadableState {
	readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
	#done = false;
	#released = false;

	constructor(readable: ReadableStream<Uint8Array>) {
		this.#reader = readerOf(readable);
	}

	async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
		if (this.#done) {
			controller.close();
			return;
		}
		try {
			const entry = await this.#reader.read();
			if (this.#done) return;
			if (entry.done) {
				this.#done = true;
				this.#releaseReader();
				controller.close();
				return;
			}
			if (!(entry.value instanceof Uint8Array)) {
				throw new TypeError("Durable Object RPC readable streams require Uint8Array chunks");
			}
			controller.enqueue(entry.value);
		} catch (error) {
			this.#done = true;
			await this.#reader.cancel(error).catch(() => undefined);
			this.#releaseReader();
			controller.error(error);
		}
	}

	async cancel(reason: unknown): Promise<void> {
		if (this.#done) return;
		this.#done = true;
		try {
			await this.#reader.cancel(reason);
		} finally {
			this.#releaseReader();
		}
	}

	#releaseReader(): void {
		if (this.#released) return;
		this.#released = true;
		this.#reader.releaseLock();
	}
}

class ReadableCancelTarget extends DurableObjectRpcTarget {
	readonly #state: OutgoingReadableState;

	constructor(state: OutgoingReadableState) {
		super();
		this.#state = state;
	}

	async cancel(reason: unknown): Promise<void> {
		await this.#state.cancel(reason);
	}

	[Symbol.dispose](): void {
		void this.#state.cancel(
			new Error("Durable Object RPC readable stream was released"),
		);
	}
}

function defineLocalTransport<T extends object>(
	transport: T,
	localValue: object,
	dispose: () => Promise<void>,
): T {
	Object.defineProperty(transport, localExternalValue, { value: localValue });
	Object.defineProperty(transport, Symbol.asyncDispose, { value: dispose });
	return transport;
}

function prepareReadable(
	readable: ReadableStream<Uint8Array>,
): PreparedReadableTransport {
	const state = new OutgoingReadableState(readable);
	const cancelTarget = new ReadableCancelTarget(state);
	return {
		cancelTarget,
		dispose: () =>
			state.cancel(
				new Error(
					"Durable Object RPC readable stream was released before transfer",
				),
			),
		readable: new ReadableStream<Uint8Array>({
			cancel: (reason) => state.cancel(reason),
			pull: (controller) => state.pull(controller),
		}),
	};
}

function encodeReadable(readable: ReadableStream<Uint8Array>): object {
	const prepared = prepareReadable(readable);
	return defineLocalTransport(
		{
			cancelTarget: prepared.cancelTarget,
			readable: prepared.readable,
		},
		readable,
		prepared.dispose,
	);
}

interface NodeRequestInit extends RequestInit {
	duplex: "half";
}

function encodeRequest(request: Request): object {
	if (request.body === null) {
		return defineLocalTransport(
			{ request: new Request(request) },
			request,
			async () => undefined,
		);
	}
	const prepared = prepareReadable(request.body);
	const init: NodeRequestInit = {
		body: prepared.readable,
		duplex: "half",
	};
	return defineLocalTransport(
		{
			cancelTarget: prepared.cancelTarget,
			request: new Request(request, init),
		},
		request,
		prepared.dispose,
	);
}

function encodeResponse(response: Response): object {
	// A network error response has status 0, which the Response constructor
	// rejects, so it travels as a flag.
	if (response.type === "error") {
		return defineLocalTransport({ networkError: true }, response, async () => undefined);
	}
	if (response.body === null) {
		return defineLocalTransport(
			{ response: new Response(null, response) },
			response,
			async () => undefined,
		);
	}
	const prepared = prepareReadable(response.body);
	return defineLocalTransport(
		{
			cancelTarget: prepared.cancelTarget,
			response: new Response(prepared.readable, response),
		},
		response,
		prepared.dispose,
	);
}

function isObjectLike(value: unknown): value is object {
	return (
		(typeof value === "object" && value !== null) ||
		typeof value === "function"
	);
}

function requireTransportObject(value: object, name: string): object {
	const result: unknown = Reflect.get(value, name);
	if (!isObjectLike(result)) {
		throw new DOMException(`RPC ${name} transport is invalid`, "DataCloneError");
	}
	return result;
}

function callDisposer(value: object): void {
	const dispose = Reflect.get(value, Symbol.dispose);
	if (typeof dispose === "function") Reflect.apply(dispose, value, []);
}

async function callRemoteCancel(
	cancelTarget: object,
	reason: unknown,
): Promise<void> {
	const cancel = Reflect.get(cancelTarget, "cancel");
	if (typeof cancel !== "function") {
		throw new DOMException(
			"RPC readable cancellation target is invalid",
			"DataCloneError",
		);
	}
	await Reflect.apply(cancel, cancelTarget, [reason]);
}

function decodeReadableParts(
	readable: ReadableStream<Uint8Array>,
	cancelTarget: object,
): ReadableStream<Uint8Array> {
	const reader = readerOf(readable);
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		reader.releaseLock();
		callDisposer(cancelTarget);
	};
	return new ReadableStream<Uint8Array>({
		async cancel(reason): Promise<void> {
			const results = await Promise.allSettled([
				reader.cancel(reason),
				callRemoteCancel(cancelTarget, reason),
			]);
			release();
			const failures = results
				.filter((result) => result.status === "rejected")
				.map((result) => result.reason);
			if (failures.length !== 0) {
				throw new AggregateError(
					failures,
					"Failed to cancel Durable Object RPC readable stream",
				);
			}
		},
		async pull(controller): Promise<void> {
			try {
				const entry = await reader.read();
				if (entry.done) {
					release();
					controller.close();
					return;
				}
				if (!(entry.value instanceof Uint8Array)) {
					throw new TypeError(
						"Durable Object RPC readable streams require Uint8Array chunks",
					);
				}
				controller.enqueue(entry.value);
			} catch (error) {
				release();
				controller.error(error);
			}
		},
	});
}

// Cap'n Web reads a Blob's bytes into a new Blob before the value arrives.
function decodeBlob(value: object): Blob {
	if (!(value instanceof Blob) || Object.getPrototypeOf(value) !== Blob.prototype) {
		throw new DOMException("RPC blob transport is invalid", "DataCloneError");
	}
	return value;
}

function decodeReadable(value: object): ReadableStream<Uint8Array> {
	const readable = requireTransportObject(value, "readable");
	if (!(readable instanceof ReadableStream)) {
		throw new DOMException("RPC readable transport is invalid", "DataCloneError");
	}
	return decodeReadableParts(
		readable,
		requireTransportObject(value, "cancelTarget"),
	);
}

function decodeRequest(value: object): Request {
	const request = requireTransportObject(value, "request");
	if (!(request instanceof Request)) {
		throw new DOMException("RPC request transport is invalid", "DataCloneError");
	}
	if (request.body === null) return new Request(request);
	const init: NodeRequestInit = {
		body: decodeReadableParts(
			request.body,
			requireTransportObject(value, "cancelTarget"),
		),
		duplex: "half",
	};
	return new Request(request, init);
}

function decodeResponse(value: object): Response {
	if (Reflect.get(value, "networkError") === true) return Response.error();
	const response = requireTransportObject(value, "response");
	if (!(response instanceof Response)) {
		throw new DOMException("RPC response transport is invalid", "DataCloneError");
	}
	if (response.body === null) return new Response(null, response);
	return new Response(
		decodeReadableParts(
			response.body,
			requireTransportObject(value, "cancelTarget"),
		),
		response,
	);
}

export function encodeRpcExternalTransport(
	kind: RpcValueExternalKind,
	value: object,
): object {
	switch (kind) {
		case "readable-stream":
			if (value instanceof ReadableStream) return encodeReadable(value);
			break;
		case "request":
			if (value instanceof Request) return encodeRequest(value);
			break;
		case "response":
			if (value instanceof Response) return encodeResponse(value);
			break;
		case "writable-stream":
			if (value instanceof WritableStream) return withInternalWriter(value);
			break;
		default:
			return value;
	}
	throw new DOMException(`RPC ${kind} external is invalid`, "DataCloneError");
}

export function decodeRpcExternalTransport(
	kind: RpcValueExternalKind,
	value: object,
): object {
	const local: unknown = Reflect.get(value, localExternalValue);
	if (isObjectLike(local)) return local;
	switch (kind) {
		case "blob":
			return decodeBlob(value);
		case "readable-stream":
			return decodeReadable(value);
		case "request":
			return decodeRequest(value);
		case "response":
			return decodeResponse(value);
		default:
			return value;
	}
}

// Cap'n Web provides bounded flow control for the byte path. Orange adds the
// explicit cancel target because Cap'n Web 0.12's readable pipe acknowledges a
// receiving reader.cancel() without reliably canceling the original source.
// https://github.com/cloudflare/capnweb/blob/770eec594df59bc44b5e45582f20ed91ea9ffb60/src/streams.ts#L1-L257
