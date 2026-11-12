import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A Durable Object's output gate. Workerd holds every outgoing message, such as a fetch, an RPC
 * call, or a WebSocket frame, until the writes made before it are durable.
 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/io-context.c%2B%2B#L396-L399
 */
export interface OutputGate {
	/**
	 * Resolves once every write made before this call is durable, and rejects once the object
	 * broke. Returns undefined when no earlier write is still pending.
	 */
	wait(): Promise<void> | undefined;
}

// Code running for a Durable Object event, like workerd's actor IoContext. Plain Worker code has
// no output gate.
const currentOutputGate = new AsyncLocalStorage<OutputGate>();

export function runWithOutputGate<Result>(
	gate: OutputGate,
	callback: () => Result,
): Result {
	return currentOutputGate.run(gate, callback);
}

/** Runs Worker code, such as a service binding callee, outside the caller's output gate. */
export function runOutsideOutputGate<Result>(callback: () => Result): Result {
	return currentOutputGate.exit(callback);
}

export function currentDurableObjectOutputGate(): OutputGate | undefined {
	return currentOutputGate.getStore();
}

/** The output gate wait for an outgoing message, or undefined when it can go out now. */
export function waitForOutputGate(): Promise<void> | undefined {
	return currentOutputGate.getStore()?.wait();
}

/**
 * Releases outgoing frames in send order, each after the output lock taken when it was sent.
 * Later writes therefore never hold an earlier frame. A broken lock drops its frame and every
 * later one, because the object is resetting.
 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/web-socket.c%2B%2B#L960-L975
 */
export class OrderedOutput {
	readonly #onError: (error: unknown) => void;
	#failed = false;
	#pending = 0;
	#tail: Promise<void> = Promise.resolve();

	constructor(onError: (error: unknown) => void) {
		this.#onError = onError;
	}

	release(outputLock: Promise<void> | undefined, deliver: () => void): void {
		if (this.#failed) return;
		if (outputLock === undefined && this.#pending === 0) {
			deliver();
			return;
		}
		this.#pending += 1;
		this.#tail = this.#tail
			.then(() => outputLock)
			.then(
				() => {
					this.#pending -= 1;
					if (this.#failed) return;
					try {
						deliver();
					} catch (error: unknown) {
						this.#onError(error);
					}
				},
				() => {
					this.#pending -= 1;
					this.#failed = true;
				},
			);
	}
}

/**
 * Holds a transport's outgoing frames and close behind a Durable Object's output gate, in order.
 * The gate is captured explicitly because the transport sends from callbacks outside the
 * object's async context.
 */
export function holdOutgoingFrames<Transport extends object>(
	transport: Transport,
	gate: OutputGate | undefined,
	onError: (error: unknown) => void,
): Transport {
	if (gate === undefined) return transport;
	const output = new OrderedOutput(onError);
	return new Proxy(transport, {
		get(target, property): unknown {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (property === "send" || property === "close") {
				return (...args: unknown[]): void => {
					output.release(gate.wait(), () => {
						Reflect.apply(value, target, args);
					});
				};
			}
			return value.bind(target);
		},
		set(target, property, value: unknown): boolean {
			return Reflect.set(target, property, value, target);
		},
	});
}
