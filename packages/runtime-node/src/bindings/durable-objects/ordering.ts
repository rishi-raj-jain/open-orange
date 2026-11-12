import { randomUUID } from "node:crypto";

import { waitForOutputGate } from "../../internal/output-gate.js";
import { isRecord } from "../unknown-values.js";
import {
	markDurableObjectResetRpcError,
	markStubBreakingRpcError,
	rpcErrorKeepsStub,
} from "./rpc/codec.js";

export interface DurableObjectStubOrder {
	readonly key: string;
	readonly sequence: number;
	/**
	 * The lowest sequence of this key that the caller has not seen settle. Every call below it has
	 * settled, so the callee need not wait for one that never arrived. Defaults to 0.
	 */
	readonly floor?: number;
}

export interface DurableObjectStubOperation<Result> {
	readonly abortController: AbortController;
	readonly promise: Promise<Result>;
}

interface ActiveStubOperation {
	readonly abortController: AbortController;
	readonly failure: PromiseWithResolvers<never>;
}

// Calls from one process to one Durable Object, in the order they are made. Every stub of the
// object shares it, as workerd delivers calls from one process in order whichever stub made them.
// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/actor.c%2B%2B#L85
class DurableObjectCallChannel {
	readonly key = randomUUID();
	readonly #inFlight = new Set<number>();
	#nextSequence = 0;

	nextOrder(): DurableObjectStubOrder {
		let floor = this.#nextSequence;
		for (const sequence of this.#inFlight) if (sequence < floor) floor = sequence;
		return { floor, key: this.key, sequence: this.#nextSequence };
	}

	take(order: DurableObjectStubOrder): void {
		this.#nextSequence = order.sequence + 1;
		this.#inFlight.add(order.sequence);
	}

	settle(sequence: number): void {
		this.#inFlight.delete(sequence);
	}
}

const sharedChannels = new Map<string, DurableObjectCallChannel>();

export class DurableObjectStubLifecycle {
	readonly #active = new Set<ActiveStubOperation>();
	readonly #objectKey: string | undefined;
	readonly #privateChannel: DurableObjectCallChannel | undefined;
	#poisoned = false;
	#poisonReason: unknown;

	/**
	 * Stubs with the same `objectKey` share one call order. Without one, the stub orders its own
	 * calls only.
	 */
	constructor(objectKey?: string) {
		this.#objectKey = objectKey;
		this.#privateChannel = objectKey === undefined ? new DurableObjectCallChannel() : undefined;
	}

	// Looked up at each call, so a stub made before a broken channel was retired gets the new one.
	#channel(): DurableObjectCallChannel {
		if (this.#privateChannel !== undefined) return this.#privateChannel;
		const objectKey = this.#objectKey as string;
		let channel = sharedChannels.get(objectKey);
		if (channel === undefined) {
			channel = new DurableObjectCallChannel();
			sharedChannels.set(objectKey, channel);
		}
		return channel;
	}

	// A broken channel goes, so later calls from any stub start a new one, as a new workerd stub would.
	#retire(channel: DurableObjectCallChannel): void {
		if (this.#objectKey !== undefined && sharedChannels.get(this.#objectKey) === channel) {
			sharedChannels.delete(this.#objectKey);
		}
	}

	start<Result>(
		operation: (
			order: DurableObjectStubOrder,
			signal: AbortSignal,
		) => Promise<Result>,
	): DurableObjectStubOperation<Result> {
		return this.startPrepared((order) => order, operation);
	}

	/**
	 * Runs `prepare` with the call's order before the call leaves, as workerd
	 * serializes RPC arguments at the call site. When `prepare` throws, the call
	 * never leaves: the stub stays usable and the order goes to the next call.
	 */
	startPrepared<Prepared, Result>(
		prepare: (order: DurableObjectStubOrder) => Prepared,
		operation: (prepared: Prepared, signal: AbortSignal) => Promise<Result>,
	): DurableObjectStubOperation<Result> {
		const abortController = new AbortController();
		if (this.#poisoned) {
			abortController.abort(this.#poisonReason);
			return {
				abortController,
				promise: Promise.reject(this.#poisonReason),
			};
		}
		const channel = this.#channel();
		const order = channel.nextOrder();
		let prepared: Prepared;
		try {
			prepared = prepare(order);
		} catch (error) {
			return { abortController, promise: Promise.reject(error) };
		}
		channel.take(order);
		const active = {
			abortController,
			failure: Promise.withResolvers<never>(),
		};
		this.#active.add(active);
		// A Durable Object's fetch or RPC call through a stub leaves after its earlier writes are
		// durable. The callee orders calls by sequence, so a held call still runs in E-order.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-rpc.c%2B%2B#L558-L562
		const outputLock = waitForOutputGate();
		let result: Promise<Result>;
		try {
			result =
				outputLock === undefined
					? operation(prepared, abortController.signal)
					: outputLock.then(() => operation(prepared, abortController.signal));
		} catch (error) {
			result = Promise.reject(error);
		}
		void result.then(
			() => channel.settle(order.sequence),
			(error: unknown) => {
				channel.settle(order.sequence);
				if (!rpcErrorKeepsStub(error)) this.#retire(channel);
			},
		);
		return {
			abortController,
			promise: Promise.race([result, active.failure.promise]).then(
				(value) => {
					this.#active.delete(active);
					return value;
				},
				(error) => {
					// The object's own error leaves the stub usable, as in workerd.
					if (!rpcErrorKeepsStub(error)) this.#poison(error);
					this.#active.delete(active);
					return Promise.reject(this.#poisoned ? this.#poisonReason : error);
				},
			),
		};
	}

	/** Breaks the stub: in-flight and later calls reject with `reason`. */
	abort(reason: unknown): void {
		this.#poison(reason);
	}

	#poison(reason: unknown): void {
		if (this.#poisoned) return;
		this.#poisoned = true;
		this.#poisonReason = reason;
		for (const active of this.#active) {
			active.failure.reject(reason);
			active.abortController.abort(reason);
		}
	}
}

interface DurableObjectOrderLane {
	nextSequence: number;
	poisoned: boolean;
	poisonReason?: unknown;
	readonly waiting: Map<number, PromiseWithResolvers<void>>;
}

export function requireDurableObjectStubOrder(
	value: unknown,
): DurableObjectStubOrder {
	if (!isRecord(value)) {
		throw new TypeError("Durable Object stub order must be an object");
	}
	const key = value.key;
	const sequence = value.sequence;
	const floor = value.floor ?? 0;
	if (typeof key !== "string" || key.length === 0 || key.length > 128) {
		throw new TypeError("Durable Object stub order key is invalid");
	}
	if (
		typeof sequence !== "number" ||
		!Number.isSafeInteger(sequence) ||
		sequence < 0
	) {
		throw new TypeError("Durable Object stub order sequence is invalid");
	}
	if (typeof floor !== "number" || !Number.isSafeInteger(floor) || floor < 0 || floor > sequence) {
		throw new TypeError("Durable Object stub order floor is invalid");
	}
	return { floor, key, sequence };
}

function stubBreakingError(message: string): Error {
	const error = new Error(message);
	markStubBreakingRpcError(error);
	return error;
}

export class DurableObjectOrderCoordinator {
	readonly #lanes = new Map<string, DurableObjectOrderLane>();

	async run<Result>(
		order: DurableObjectStubOrder,
		operation: () => Result | Promise<Result>,
	): Promise<Result> {
		const lane = this.#requireLane(order.key);
		await this.#waitForTurn(lane, order);
		let result: Promise<Result>;
		try {
			result = Promise.resolve(operation());
		} catch (error) {
			result = Promise.reject(error);
		}
		this.#advance(lane);
		return await result;
	}

	#advance(lane: DurableObjectOrderLane): void {
		lane.nextSequence += 1;
		const next = lane.waiting.get(lane.nextSequence);
		if (next !== undefined) {
			lane.waiting.delete(lane.nextSequence);
			next.resolve();
		}
	}

	// Breaks the stub that owns `key`: its later calls fail with `reason`.
	poisonLane(key: string, reason: unknown): void {
		this.#poison(this.#requireLane(key), reason);
	}

	#poison(lane: DurableObjectOrderLane, reason: unknown): void {
		if (lane.poisoned) return;
		markDurableObjectResetRpcError(reason);
		lane.poisoned = true;
		lane.poisonReason = reason;
		for (const waiter of lane.waiting.values()) waiter.reject(reason);
		lane.waiting.clear();
	}

	#requireLane(key: string): DurableObjectOrderLane {
		let lane = this.#lanes.get(key);
		if (lane === undefined) {
			lane = {
				nextSequence: 0,
				poisoned: false,
				waiting: new Map(),
			};
			this.#lanes.set(key, lane);
		}
		return lane;
	}

	// Every call below `floor` has settled for the caller. One that has not arrived never will, or
	// arrives stale, so the lane moves past it. A new lane, as after a restart, starts there too.
	#skipTo(lane: DurableObjectOrderLane, floor: number): void {
		for (const [sequence, waiter] of lane.waiting) {
			if (sequence >= floor) continue;
			lane.waiting.delete(sequence);
			waiter.reject(stubBreakingError("Durable Object stub operation is duplicated or stale"));
		}
		lane.nextSequence = floor;
		const next = lane.waiting.get(floor);
		if (next !== undefined) {
			lane.waiting.delete(floor);
			next.resolve();
		}
	}

	async #waitForTurn(
		lane: DurableObjectOrderLane,
		{ floor = 0, sequence }: DurableObjectStubOrder,
	): Promise<void> {
		if (lane.poisoned) throw lane.poisonReason;
		if (floor > lane.nextSequence) this.#skipTo(lane, floor);
		if (sequence < lane.nextSequence || lane.waiting.has(sequence)) {
			throw stubBreakingError("Durable Object stub operation is duplicated or stale");
		}
		if (sequence - lane.nextSequence > 1_024) {
			throw stubBreakingError("Durable Object stub operation is too far out of order");
		}
		if (sequence === lane.nextSequence) return;
		const turn = Promise.withResolvers<void>();
		lane.waiting.set(sequence, turn);
		await turn.promise;
	}
}

// A workerd Durable Object stub owns one lazily-created actor channel. The
// channel preserves E-order until a failure breaks it; retryable actor fetches
// refresh routing inside that call, while a later user call needs a new stub.
// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/actor.c%2B%2B#L85-L154
