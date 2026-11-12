import { ReadableStream, TransformStream, WritableStream } from "./native.js";
import { keepLockedAfterPipe, pipeIntoState } from "./stream-compat.js";
import { recordExpectedLength } from "./web-compat.js";

export interface IdentityTransformStreamQueuingStrategy {
	highWaterMark?: number | bigint;
}

interface PendingWrite {
	bytes: Uint8Array;
	reject(reason: unknown): void;
	resolve(): void;
}

interface IdentityState {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<ArrayBuffer | ArrayBufferView>;
}

const identityStates = new WeakMap<object, IdentityState>();

function identityState(stream: object): IdentityState {
	const state = identityStates.get(stream);
	if (state === undefined) throw new TypeError("Illegal invocation");
	return state;
}

const encoder = new TextEncoder();

// workerd copies each written chunk and accepts strings as UTF-8 bytes.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/internal.c%2B%2B#L1240-L1262
function chunkBytes(chunk: unknown): Uint8Array {
	if (typeof chunk === "string") {
		return encoder.encode(chunk);
	}
	if (chunk instanceof ArrayBuffer || chunk instanceof SharedArrayBuffer) {
		return new Uint8Array(chunk).slice();
	}
	if (ArrayBuffer.isView(chunk)) {
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
	}
	throw new TypeError(
		"This TransformStream is being used as a byte stream, but received an object of non-ArrayBuffer/ArrayBufferView type on its writable side.",
	);
}

interface ByteController {
	readonly byobRequest: {
		readonly view: ArrayBufferView | null;
		respond(bytesWritten: number): void;
	} | null;
	close(): void;
	enqueue(chunk: ArrayBufferView): void;
	error(reason?: unknown): void;
}

// Builds workerd's identity pipe: a byte-stream readable whose writes resolve
// only after a reader consumes them, so the pair holds no internal buffer.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/identity-transform-stream.c%2B%2B#L60-L330
function createIdentityPipe(expectedLength?: bigint): IdentityState {
	let pending: PendingWrite | undefined;
	let pullWaiter: (() => void) | undefined;
	let readableController: ByteController | undefined;
	let writableController: WritableStreamDefaultController | undefined;
	let remaining = expectedLength;

	const deliver = (controller: ByteController): void => {
		const write = pending;
		if (write === undefined) return;
		const request = controller.byobRequest;
		const view = request?.view;
		if (request !== null && request !== undefined && view !== null && view !== undefined) {
			const count = Math.min(view.byteLength, write.bytes.byteLength);
			new Uint8Array(view.buffer, view.byteOffset, count).set(
				write.bytes.subarray(0, count),
			);
			request.respond(count);
			write.bytes = write.bytes.subarray(count);
		} else {
			controller.enqueue(write.bytes);
			write.bytes = new Uint8Array(0);
		}
		if (write.bytes.byteLength === 0) {
			pending = undefined;
			write.resolve();
		}
	};

	const readable = new ReadableStream({
		type: "bytes",
		start(controller: ByteController) {
			readableController = controller;
		},
		pull(controller: ByteController): Promise<void> | undefined {
			if (pending !== undefined) {
				deliver(controller);
				return undefined;
			}
			return new Promise<void>((resolve) => {
				pullWaiter = resolve;
			});
		},
		cancel(reason: unknown) {
			pending?.reject(reason);
			pending = undefined;
			writableController?.error(reason);
		},
	}, { highWaterMark: 0 });

	const writable = new WritableStream<ArrayBuffer | ArrayBufferView>({
		start(controller: WritableStreamDefaultController) {
			writableController = controller;
		},
		write(chunk: unknown): Promise<void> | undefined {
			const pipe = pipeIntoState(writable);
			// Workerd's pipe loop stops writing once its signal aborts, so a chunk
			// read after the abort never reaches the identity pipe.
			// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/internal.c%2B%2B#L2531-L2535
			if (pipe?.signal?.aborted === true) return undefined;
			let bytes: Uint8Array;
			try {
				bytes = chunkBytes(chunk);
			} catch (error: unknown) {
				if (pipe === undefined) throw error;
				// A pipe into an internal writable aborts it on a non-byte chunk.
				// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/internal.c%2B%2B#L2496-L2501
				const noBytes = new TypeError("This WritableStream only supports writing byte types.");
				readableController?.error(noBytes);
				throw noBytes;
			}
			if (remaining !== undefined) {
				if (BigInt(bytes.byteLength) > remaining) {
					const error = new TypeError(
						"Attempt to write too many bytes through a FixedLengthStream.",
					);
					readableController?.error(error);
					throw error;
				}
				remaining -= BigInt(bytes.byteLength);
			}
			if (bytes.byteLength === 0) return undefined;
			const { promise, reject, resolve } = Promise.withResolvers<void>();
			const write = { bytes, reject, resolve };
			pending = write;
			// Aborting the pipe cancels a write that no reader has taken yet, and the
			// readable side reports the lost data instead of waiting for it.
			// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/identity-transform-stream-uaf-test.js#L24-L67
			pipe?.signal?.addEventListener(
				"abort",
				() => {
					if (pending !== write) return;
					pending = undefined;
					const reason: unknown = pipe.signal?.reason;
					readableController?.error(reason);
					write.reject(reason);
				},
				{ once: true },
			);
			const waiter = pullWaiter;
			pullWaiter = undefined;
			if (waiter !== undefined && readableController !== undefined) {
				deliver(readableController);
				waiter();
			}
			return promise;
		},
		close() {
			if (remaining !== undefined && remaining > 0n) {
				const error = new TypeError(
					"FixedLengthStream did not see all expected bytes before close().",
				);
				readableController?.error(error);
				throw error;
			}
			if (pipeIntoState(writable) !== undefined) keepLockedAfterPipe(writable);
			readableController?.close();
			readableController?.byobRequest?.respond(0);
			const waiter = pullWaiter;
			pullWaiter = undefined;
			waiter?.();
		},
		abort(reason: unknown) {
			readableController?.error(reason);
			const waiter = pullWaiter;
			pullWaiter = undefined;
			waiter?.();
		},
	});

	if (expectedLength !== undefined) recordExpectedLength(readable, expectedLength);
	return { readable, writable };
}

export class IdentityTransformStream extends TransformStream<
	ArrayBuffer | ArrayBufferView,
	Uint8Array
> {
	constructor(_strategy?: IdentityTransformStreamQueuingStrategy) {
		super();
		identityStates.set(this, createIdentityPipe());
	}

	override get readable(): ReadableStream<Uint8Array> {
		return identityState(this).readable;
	}

	override get writable(): WritableStream<ArrayBuffer | ArrayBufferView> {
		return identityState(this).writable;
	}
}

function expectedLengthValue(value: unknown): bigint {
	const number = typeof value === "bigint" ? 0 : Number(value);
	const length =
		typeof value === "bigint"
			? value
			: Number.isFinite(number)
				? BigInt(Math.trunc(number))
				: -1n;
	if (length < 0n || length > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new TypeError(
			"FixedLengthStream requires an integer expected length less than 2^53.",
		);
	}
	return length;
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/identity-transform-stream.c%2B%2B#L368-L390
export class FixedLengthStream extends IdentityTransformStream {
	constructor(
		expectedLength: number | bigint,
		_strategy?: IdentityTransformStreamQueuingStrategy,
	) {
		super();
		identityStates.set(this, createIdentityPipe(expectedLengthValue(expectedLength)));
	}
}

function isPartialFinalRead(result: unknown): result is { value: ArrayBufferView } {
	if (typeof result !== "object" || result === null) return false;
	const value: unknown = Reflect.get(result, "value");
	return (
		Reflect.get(result, "done") === true &&
		ArrayBuffer.isView(value) &&
		value.byteLength > 0
	);
}

interface ByobReader {
	read(view: ArrayBufferView, options?: { min?: number }): Promise<unknown>;
}

// workerd adds readAtLeast() to BYOB readers. Node supports the same contract
// through the standard read(view, { min }) option.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/readable.c%2B%2B#L95-L126
export function installReadAtLeast(ReaderClass: Function): void {
	const prototype: unknown = Reflect.get(ReaderClass, "prototype");
	if (typeof prototype !== "object" || prototype === null) return;
	if (Object.hasOwn(prototype, "readAtLeast")) return;
	Object.defineProperty(prototype, "readAtLeast", {
		configurable: true,
		enumerable: true,
		writable: true,
		value(this: ByobReader, minElements: number, view: ArrayBufferView): Promise<unknown> {
			const min = Number(minElements);
			if (!Number.isInteger(min) || min < -2_147_483_648 || min > 2_147_483_647) {
				return Promise.reject(new TypeError("Minimum elements to read must be an int."));
			}
			if (min === 0) {
				return Promise.reject(
					new TypeError(`Requested invalid minimum number of bytes to read (${min}).`),
				);
			}
			if (min < 0 || min > view.byteLength) {
				return Promise.reject(
					new TypeError(
						`Minimum bytes to read (${min}) exceeds size of buffer (${view.byteLength}).`,
					),
				);
			}
			// Workerd resolves a partly filled read as not done when the stream
			// closes, and reports done on the next read.
			// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/streams-test.js#L684-L720
			return this.read(view, { min }).then((result) =>
				isPartialFinalRead(result) ? { done: false, value: result.value } : result,
			);
		},
	});
}
