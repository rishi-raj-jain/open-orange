// Aligns Node.js web-platform classes with workerd where workerd differs on
// purpose. Orange installs these same Node classes as Worker globals, so the
// patches apply at the global boundary.

const nativeQueueMicrotask = globalThis.queueMicrotask;

interface ByteStreamController {
	readonly byobRequest: { respond(bytesWritten: number): void } | null;
	close(): void;
}

function isByteStreamControllerConstructor(
	value: unknown,
): value is { prototype: ByteStreamController } {
	if (typeof value !== "function") return false;
	const prototype: unknown = Reflect.get(value, "prototype");
	return (
		typeof prototype === "object" &&
		prototype !== null &&
		typeof Reflect.get(prototype, "close") === "function"
	);
}

function installByteStreamCloseDrain(): void {
	const controller: unknown = Reflect.get(globalThis, "ReadableByteStreamController");
	if (!isByteStreamControllerConstructor(controller)) {
		throw new Error("Node.js does not provide the required ReadableByteStreamController global");
	}
	// Without the pedantic_wpt flag, workerd completes pending BYOB reads with
	// the bytes filled so far when the source closes the stream, so a source
	// does not have to respond to the outstanding request. A source that does
	// respond in the same turn still can, so the drain waits one microtask.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/queue.c%2B%2B#L1053-L1068
	const close = controller.prototype.close;
	Object.defineProperty(controller.prototype, "close", {
		configurable: true,
		enumerable: true,
		value: function closeAndDrain(this: ByteStreamController): void {
			Reflect.apply(close, this, []);
			nativeQueueMicrotask(() => {
				const request = this.byobRequest;
				if (request === null) return;
				try {
					request.respond(0);
				} catch {
					// The stream errored or the request was invalidated in between.
				}
			});
		},
		writable: true,
	});
}

type StreamKind = "readable" | "transform" | "writable";

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

// Workerd converts a synchronous throw from start() into a rejected promise,
// so the stream ends up errored instead of the constructor throwing.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L604-L646
function withAsyncStart<T>(underlying: T): T {
	if (!isObject(underlying)) return underlying;
	return new Proxy(underlying, {
		get(target, key, receiver) {
			const value: unknown = Reflect.get(target, key, receiver);
			if (key !== "start" || typeof value !== "function") return value;
			return function start(this: unknown, ...args: unknown[]): unknown {
				try {
					return Reflect.apply(value, target, args);
				} catch (error: unknown) {
					return Promise.reject(error);
				}
			};
		},
	});
}

// Workerd validates the remaining underlying-source options with TypeErrors
// where Node.js throws RangeErrors or internal assertion errors.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L3188-L3190
function validateReadableSource(source: unknown): void {
	if (!isObject(source) || Reflect.get(source, "type") !== "bytes") return;
	const chunkSize: unknown = Reflect.get(source, "autoAllocateChunkSize");
	if (chunkSize === undefined) return;
	const size = Number(chunkSize);
	if (size === 0) {
		throw new TypeError("The autoAllocateChunkSize option cannot be zero.");
	}
	if (!Number.isInteger(size) || size < 0) {
		throw new TypeError("The autoAllocateChunkSize option must be a positive integer.");
	}
}

function isHighWaterMarkError(error: unknown): error is Error {
	return (
		error instanceof RangeError &&
		Reflect.get(error, "code") === "ERR_INVALID_ARG_VALUE" &&
		error.message.includes("highWaterMark")
	);
}

const expectedLengths = new WeakMap<object, bigint>();

function expectedLengthOption(underlying: unknown): bigint | undefined {
	if (!isObject(underlying)) return undefined;
	const value: unknown = Reflect.get(underlying, "expectedLength");
	if (value === undefined) return undefined;
	const length =
		typeof value === "bigint"
			? value
			: Number.isSafeInteger(Number(value))
				? BigInt(Number(value))
				: -1n;
	if (length < 0n) {
		throw new TypeError("The expectedLength option must be a non-negative integer.");
	}
	return length;
}

// Records the declared byte length of a stream body. Workerd sends it as the
// Content-Length of a request or response that uses the stream.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L3743-L3746
export function recordExpectedLength(stream: object, length: bigint): void {
	expectedLengths.set(stream, length);
}

export function expectedLengthOf(stream: object): bigint | undefined {
	return expectedLengths.get(stream);
}

export function workerdStreamConstructor<Constructor extends Function>(
	native: Constructor,
	kind: StreamKind,
): Constructor {
	// Forwarding toString keeps the class source visible, as for workerd's
	// JavaScript stream classes, instead of a Proxy's "[native code]".
	const toString = (): string => Function.prototype.toString.call(native);
	return new Proxy(native, {
		get(target, key, receiver) {
			return key === "toString" ? toString : Reflect.get(target, key, receiver);
		},
		construct(target, args, newTarget) {
			const [underlying, ...strategies] = args;
			if (kind === "readable") validateReadableSource(underlying);
			const expectedLength = kind === "writable" ? undefined : expectedLengthOption(underlying);
			try {
				const stream: object = Reflect.construct(
					target,
					[withAsyncStart(underlying), ...strategies],
					newTarget,
				);
				if (expectedLength !== undefined) {
					// A transformer's expectedLength describes its readable side.
					// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/transform.c%2B%2B#L70-L71
					const readable: unknown =
						kind === "transform" ? Reflect.get(stream, "readable") : stream;
					if (isObject(readable)) recordExpectedLength(readable, expectedLength);
				}
				return stream;
			} catch (error: unknown) {
				// Workerd rejects an invalid highWaterMark with a TypeError.
				if (isHighWaterMarkError(error)) throw new TypeError(error.message);
				throw error;
			}
		},
	});
}

const NativeBlob = Blob;
const NativeReadableStream = ReadableStream;

// Workerd also caps a Blob at 128 MiB, a Cloudflare quota that Orange does not copy. Node's own
// buffer limit still applies. Workerd rejects resizable buffers only under the
// no_resizable_array_buffer_in_blob flag, which is off by default.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/blob.c%2B%2B#L23-L66
export function workerdBlobConstructor<Constructor extends Function>(
	native: Constructor,
): Constructor {
	return new Proxy(native, {
		construct(target, args, newTarget) {
			const [parts, options] = args;
			// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/blob.h#L30-L35
			if (
				typeof options === "object" &&
				options !== null &&
				Reflect.get(options, "endings") !== undefined
			) {
				throw new Error("The 'endings' field on 'Options' is not implemented.");
			}
			return Reflect.construct(target, args, newTarget);
		},
	});
}

function installBlobStream(): void {
	// Workerd streams a Blob from one memory source, so a reader gets the whole
	// content in one chunk; Node.js yields one chunk per blob part.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/blob.c%2B%2B#L277-L283
	// Bun's `stream` is writable but not configurable, so only its value changes.
	Object.defineProperty(NativeBlob.prototype, "stream", {
		value: function stream(this: Blob): ReadableStream<Uint8Array> {
			const blob = this;
			return new NativeReadableStream({
				async pull(controller) {
					const bytes = new Uint8Array(await blob.arrayBuffer());
					if (bytes.byteLength > 0) controller.enqueue(bytes);
					controller.close();
				},
				type: "bytes",
			});
		},
	});
}

function isInvalidatedRequestError(error: unknown): boolean {
	return (
		error instanceof TypeError &&
		Reflect.get(error, "code") === "ERR_INVALID_STATE" &&
		error.message.includes("invalidated")
	);
}

function installByobRequestInvalidatedMessage(): void {
	const request: unknown = Reflect.get(globalThis, "ReadableStreamBYOBRequest");
	if (typeof request !== "function") {
		throw new Error("Node.js does not provide the required ReadableStreamBYOBRequest global");
	}
	const prototype: unknown = Reflect.get(request, "prototype");
	if (typeof prototype !== "object" || prototype === null) {
		throw new Error("Node.js ReadableStreamBYOBRequest has no prototype");
	}
	// Workerd reports a used BYOB request with its own message.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L2469-L2470
	for (const name of ["respond", "respondWithNewView"]) {
		const method: unknown = Reflect.get(prototype, name);
		if (typeof method !== "function") {
			throw new Error(`Node.js ReadableStreamBYOBRequest.${name} is missing`);
		}
		Object.defineProperty(prototype, name, {
			configurable: true,
			enumerable: true,
			value: {
				[name](this: unknown, ...args: unknown[]): unknown {
					try {
						return Reflect.apply(method, this, args);
					} catch (error: unknown) {
						if (isInvalidatedRequestError(error)) {
							throw new TypeError("This ReadableStreamBYOBRequest has been invalidated.");
						}
						throw error;
					}
				},
			}[name],
			writable: true,
		});
	}
}

installByobRequestInvalidatedMessage();
installBlobStream();
installByteStreamCloseDrain();
