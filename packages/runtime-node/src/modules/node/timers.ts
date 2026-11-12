import * as nodeTimers from "node:timers";

import {
	clearInterval,
	clearTimeout,
	startTimerFor,
	type Timeout,
} from "../../globals/timers.js";
import { validateFunction } from "../node-internal/validators.js";
import * as promises from "./timers-promises.js";

// workerd's node:timers wraps the global timers, so a Durable Object counts them as its own, and
// keeps the deprecated timer-list helpers that Node.js 24 removed. Immediates stay the host's.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_timers.ts#L135-L229

export const { clearImmediate, setImmediate } = nodeTimers;
export { clearInterval, clearTimeout, promises };

export function setTimeout(callback: Function, delay?: number, ...args: unknown[]): Timeout {
	validateFunction(callback, "callback");
	return startTimerFor(setTimeout, false, callback, delay ?? 1, args);
}

export function setInterval(callback: Function, repeat?: number, ...args: unknown[]): Timeout {
	validateFunction(callback, "callback");
	return startTimerFor(setInterval, true, callback, repeat ?? 1, args);
}

/** @deprecated Use `timeout.refresh()` instead. */
export function active(timer: unknown): void {
	if (timer instanceof Object) {
		const refresh: unknown = Reflect.get(timer, "refresh");
		if (typeof refresh === "function") Reflect.apply(refresh, timer, []);
	}
}

/** @deprecated Use `clearTimeout()` instead. */
export function unenroll(timer: Parameters<typeof clearTimeout>[0]): void {
	clearTimeout(timer);
}

/** @deprecated Use `setTimeout()` instead. */
export function enroll(_item: unknown, _msecs: number): never {
	throw new Error("Not implemented. Please use setTimeout() instead.");
}

export default {
	active,
	clearImmediate,
	clearInterval,
	clearTimeout,
	enroll,
	promises,
	setImmediate,
	setInterval,
	setTimeout,
	unenroll,
};
