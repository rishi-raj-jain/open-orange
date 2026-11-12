import { clearTimeout, startTimerFor } from "./timers.js";

export interface SchedulerWaitOptions {
	signal?: AbortSignal;
}

/** scheduler.wait() for an Orange API that the Worker calls. `api` is that function. */
export function schedulerWaitFor(
	api: Function,
	delay: number,
	options?: SchedulerWaitOptions,
): Promise<void> {
	const signal = options?.signal;
	if (signal?.aborted === true) {
		return Promise.reject(signal.reason);
	}
	const { promise, reject, resolve } = Promise.withResolvers<void>();
	const onAbort = (): void => {
		clearTimeout(timeoutId);
		reject(signal?.reason);
	};
	// A wait that the Worker started is a timer of the Worker's object.
	const timeoutId = startTimerFor(api, false, () => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, Number(delay));
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

// Mirrors workerd's scheduler.wait(): a timer-backed promise that rejects with
// the signal's reason when the optional signal aborts.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L1333-L1371
export class Scheduler {
	wait(delay: number, options?: SchedulerWaitOptions): Promise<void> {
		return schedulerWaitFor(Scheduler.prototype.wait, delay, options);
	}
}

export const scheduler = new Scheduler();
