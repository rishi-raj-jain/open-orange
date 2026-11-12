import { currentExecutionContext, onExecutionContextRelease, rpcResultOwner } from "../../../context.js";
import { isCapnWebRpcStub } from "./capnweb.js";
import type { DurableObjectRpcCallResult } from "./session.js";

type RpcOperationResolution = {
	receiver?: object;
	readonly value: unknown;
};

function isObjectLike(value: unknown): value is object {
	return (
		(typeof value === "object" && value !== null) ||
		typeof value === "function"
	);
}

function callDisposer(value: object): void {
	const dispose = Reflect.get(value, Symbol.dispose);
	if (typeof dispose === "function") Reflect.apply(dispose, value, []);
}

const neverSettles = new Promise<never>(() => undefined);

class DurableObjectRpcResultLifetime {
	readonly #abortController: AbortController;
	#abandoned = false;
	#callResult: DurableObjectRpcCallResult | undefined;
	#disposePromise: Promise<void> | undefined;
	#references = 1;
	readonly #stopOwning: () => void;
	readonly value: Promise<unknown>;

	constructor(
		callResult: Promise<DurableObjectRpcCallResult>,
		abortController: AbortController,
	) {
		this.#abortController = abortController;
		// The calling event owns the result, even when the Worker never disposes it.
		this.#stopOwning = onExecutionContextRelease(rpcResultOwner(currentExecutionContext()), () => {
			if (this.#references === 0) return;
			if (this.#callResult === undefined) {
				// The event ended with the call in flight. As on workerd, the call still runs, and the
				// caller's continuations don't. The result is disposed when it arrives.
				this.#references = 0;
				this.#abandoned = true;
				return;
			}
			this.#references = 1;
			this.release();
		});
		this.value = callResult.then(
			(result) => {
				this.#callResult = result;
				if (this.#abandoned) {
					void this.#disposeResult().catch(() => undefined);
					return neverSettles;
				}
				if (this.#references === 0) {
					void this.#disposeResult().catch(() => undefined);
					throw new Error("Durable Object RPC result was disposed");
				}
				if (!isObjectLike(result.value)) {
					this.release();
					return result.value;
				}
				return decorateRpcResult(
					result.value,
					this,
					() => this.release(),
					new WeakMap(),
				);
			},
			(error: unknown) => {
				if (this.#abandoned) return neverSettles;
				throw error;
			},
		);
	}

	decorateDerived(value: unknown): unknown {
		if (!isObjectLike(value)) return value;
		const release = this.retain();
		return decorateRpcResult(value, this, release, new WeakMap());
	}

	retain(): () => void {
		if (this.#references === 0) {
			throw new Error("Durable Object RPC result is already disposed");
		}
		this.#references += 1;
		let released = false;
		return (): void => {
			if (released) return;
			released = true;
			this.release();
		};
	}

	release(): void {
		if (this.#references === 0) return;
		this.#references -= 1;
		if (this.#references !== 0) return;
		this.#stopOwning();
		if (this.#callResult === undefined) {
			this.#abortController.abort(
				new Error("Durable Object RPC result was disposed"),
			);
			return;
		}
		void this.#disposeResult().catch(() => undefined);
	}

	async #disposeResult(): Promise<void> {
		if (this.#disposePromise === undefined) {
			this.#disposePromise = this.#callResult?.dispose() ?? Promise.resolve();
		}
		await this.#disposePromise;
	}
}

function contextEndedError(): Error {
	return new Error(
		"The execution context which hosts this callback is no longer running.",
	);
}

// What a broken stub hands out for a member: calling or awaiting it fails.
function endedContextMember(): object {
	const fail = (): Promise<never> => Promise.reject(contextEndedError());
	return new Proxy((): void => undefined, {
		apply: fail,
		get(_target, property): unknown {
			if (property === "then") {
				return (
					onFulfilled?: (value: never) => unknown,
					onRejected?: (reason: unknown) => unknown,
				) => fail().then(onFulfilled, onRejected);
			}
			if (property === "catch") {
				return (onRejected?: (reason: unknown) => unknown) => fail().catch(onRejected);
			}
			if (property === "finally") {
				return (onFinally?: () => void) => fail().finally(onFinally);
			}
			return typeof property === "string" ? endedContextMember() : undefined;
		},
	});
}

function wrapRpcStub(
	stub: object,
	lifetime: DurableObjectRpcResultLifetime,
	onDispose?: () => void,
): object {
	let disposed = false;
	// Calls made after the hosting Durable Object aborted its session fail like
	// calls into an ended workerd context. Calls already in flight keep the
	// abort reason.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/js-rpc-test.js#L2180-L2185
	let broken = false;
	const onRpcBroken: unknown = Reflect.get(stub, "onRpcBroken");
	if (typeof onRpcBroken === "function") {
		Reflect.apply(onRpcBroken, stub, [
			(): void => {
				broken = true;
			},
		]);
	}
	let wrapper: object;
	wrapper = new Proxy(stub, {
		get(target, property): unknown {
			if (property === "map" || property === "onRpcBroken") return undefined;
			if (
				broken &&
				!disposed &&
				typeof property === "string" &&
				property !== "dup" &&
				property !== "then"
			) {
				return endedContextMember();
			}
			if (property === Symbol.dispose) {
				return (): void => {
					if (disposed) return;
					disposed = true;
					try {
						callDisposer(target);
					} finally {
						onDispose?.();
					}
				};
			}
			if (property === "dup") {
				return (): object => {
					if (disposed) {
						throw new Error("Durable Object RPC stub is already disposed");
					}
					const duplicate = Reflect.get(target, "dup");
					if (typeof duplicate !== "function") {
						throw new Error("Durable Object RPC stub cannot be duplicated");
					}
					const duplicated: unknown = Reflect.apply(duplicate, target, []);
					if (!isObjectLike(duplicated)) {
						throw new Error("Durable Object RPC stub duplication failed");
					}
					return wrapRpcStub(duplicated, lifetime, lifetime.retain());
				};
			}
			return Reflect.get(target, property, target);
		},
	});
	return wrapper;
}

// workerd attaches one non-enumerable disposer to an object-valued RPC result;
// that disposer releases every capability retained by the result as a group.
// https://github.com/cloudflare/workerd/blob/dc27e996c4ab8e8849cc6229ae816b3d426f08ef/src/workerd/api/worker-rpc.c%2B%2B#L230-L259

function decorateRpcResult(
	value: object,
	lifetime: DurableObjectRpcResultLifetime,
	onDispose: (() => void) | undefined,
	seen: WeakMap<object, object>,
): object {
	const previous = seen.get(value);
	if (previous !== undefined) return previous;

	if (isCapnWebRpcStub(value)) {
		const wrapped = wrapRpcStub(
			value,
			lifetime,
			onDispose,
		);
		seen.set(value, wrapped);
		return wrapped;
	}

	seen.set(value, value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			const entry = value[index];
			if (isObjectLike(entry)) {
				value[index] = decorateRpcResult(
					entry,
					lifetime,
					undefined,
					seen,
				);
			}
		}
	} else if (value instanceof Map) {
		const entries: [unknown, unknown][] = [];
		for (const [key, entry] of value) {
			entries.push([
				isObjectLike(key)
					? decorateRpcResult(key, lifetime, undefined, seen)
					: key,
				isObjectLike(entry)
					? decorateRpcResult(entry, lifetime, undefined, seen)
					: entry,
			]);
		}
		value.clear();
		for (const [key, entry] of entries) value.set(key, entry);
	} else if (value instanceof Set) {
		const entries = [...value].map((entry) =>
			isObjectLike(entry)
				? decorateRpcResult(entry, lifetime, undefined, seen)
				: entry,
		);
		value.clear();
		for (const entry of entries) value.add(entry);
	} else if (Object.getPrototypeOf(value) === Object.prototype) {
		for (const key of Object.keys(value)) {
			const entry: unknown = Reflect.get(value, key);
			if (isObjectLike(entry)) {
				Reflect.set(
					value,
					key,
					decorateRpcResult(entry, lifetime, undefined, seen),
				);
			}
		}
	}

	if (onDispose !== undefined) {
		let disposed = false;
		Object.defineProperty(value, Symbol.dispose, {
			configurable: true,
			value(): void {
				if (disposed) return;
				disposed = true;
				onDispose();
			},
		});
	}
	return value;
}

function requireCallable(value: unknown): Function {
	if (typeof value !== "function") {
		throw new TypeError("Durable Object RPC pipeline target is not callable");
	}
	return value;
}

function createRpcPromiseProxy(
	lifetime: DurableObjectRpcResultLifetime,
	resolution: Promise<RpcOperationResolution>,
	decorateOnAwait: boolean,
): object {
	const target = (): void => undefined;
	let exposed: Promise<unknown> | undefined;
	const requireExposed = (): Promise<unknown> => {
		exposed ??= resolution.then(({ value }) =>
			decorateOnAwait ? lifetime.decorateDerived(value) : value,
		);
		return exposed;
	};
	return new Proxy(target, {
		apply(_callable, _thisArgument, args): object {
			return createRpcPromiseProxy(
				lifetime,
				resolution.then(async ({ receiver, value }) => ({
					value: await Reflect.apply(requireCallable(value), receiver, args),
				})),
				true,
			);
		},
		get(_callable, property): unknown {
			if (property === Symbol.toStringTag) return "Promise";
			if (property === "then" || property === "catch" || property === "finally") {
				const exposedPromise = requireExposed();
				const promiseMethod = Reflect.get(exposedPromise, property);
				return typeof promiseMethod === "function"
					? promiseMethod.bind(exposedPromise)
					: undefined;
			}
			if (property === "map" || property === "onRpcBroken") return undefined;
			return createRpcPromiseProxy(
				lifetime,
				resolution.then(({ value }) => {
					if (!isObjectLike(value)) {
						throw new TypeError(
							"Durable Object RPC pipeline target has no properties",
						);
					}
					return {
						receiver: value,
						value: Reflect.get(value, property, value),
					};
				}),
				true,
			);
		},
	});
}

// Workerd RPC promises expose then/catch/finally plus callable property paths;
// ordinary stubs deliberately hide `then` to avoid promise assimilation.
// https://github.com/cloudflare/workerd/blob/dc27e996c4ab8e8849cc6229ae816b3d426f08ef/src/workerd/api/worker-rpc.c%2B%2B#L644-L729
// https://github.com/cloudflare/workerd/blob/dc27e996c4ab8e8849cc6229ae816b3d426f08ef/src/workerd/api/worker-rpc.c%2B%2B#L912-L918

// Cap'n Web additionally exposes map() and onRpcBroken(); Orange filters both
// because neither is part of the pinned Workers RPC surface.
// https://github.com/cloudflare/capnweb/blob/7702075d4122e6808512ee50acc591310b77da7a/src/core.ts#L493-L557

export function createDurableObjectRpcPromise(
	callResult: Promise<DurableObjectRpcCallResult>,
	abortController: AbortController,
): object {
	const lifetime = new DurableObjectRpcResultLifetime(
		callResult,
		abortController,
	);
	return createRpcPromiseProxy(
		lifetime,
		lifetime.value.then((value) => ({ value })),
		false,
	);
}

export function createLazyDurableObjectRpcProperty(
	startGet: () => object,
	startCall: (args: readonly unknown[]) => object,
): object {
	let getPromise: object | undefined;
	const requireGetPromise = (): object => {
		getPromise ??= startGet();
		return getPromise;
	};
	const target = (): void => undefined;
	return new Proxy(target, {
		apply(_callable, _thisArgument, args): object {
			return startCall(args);
		},
		get(_callable, property): unknown {
			return Reflect.get(requireGetPromise(), property, requireGetPromise());
		},
	});
}
