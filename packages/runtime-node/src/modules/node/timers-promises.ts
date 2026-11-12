// Ported from workerd on Orange's timers, so a Durable Object counts these timers as its own.
// OpenOrange changes are marked "OpenOrange:".
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_timers_promises.ts#L35-L245
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/timers/promises.ts
// Copyright (c) 2017-2025 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Adapted from Node.js. Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

import { clearImmediate as hostClearImmediate, setImmediate as hostSetImmediate } from "node:timers";

import { schedulerWaitFor, type SchedulerWaitOptions } from "../../globals/scheduler.js";
import { clearInterval, clearTimeout, startTimerFor, type Timeout } from "../../globals/timers.js";
import { AbortError, ERR_INVALID_THIS } from "../node-internal/errors.js";
import {
	validateAbortSignal,
	validateBoolean,
	validateNumber,
	validateObject,
} from "../node-internal/validators.js";

const kScheduler = Symbol.for("kScheduler");

type OnCancelCallback = (() => void) | undefined;

interface TimerOptions {
	signal?: AbortSignal | undefined;
	ref?: boolean | undefined;
}

function validateOptions(options: TimerOptions): void {
	validateObject(options, "options");
	// Ref options is a no-op.
	const { signal, ref } = options;
	if (signal !== undefined) {
		validateAbortSignal(signal, "options.signal");
	}
	// This is required due to consistency/compat reasons, even if it's a no-op.
	if (ref !== undefined) {
		validateBoolean(ref, "options.ref");
	}
}

export async function setTimeout<T = void>(
	delay?: number,
	value?: T,
	options: TimerOptions = {},
): Promise<T> {
	if (delay !== undefined) {
		validateNumber(delay, "delay");
	}
	validateOptions(options);
	const { signal } = options;
	if (signal?.aborted === true) {
		throw new AbortError(undefined, { cause: signal.reason });
	}

	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let onCancel: OnCancelCallback;

	// OpenOrange: the timer is the Worker's when Worker code called this function.
	const timer = startTimerFor(setTimeout, false, () => {
		resolve(value as T);
		if (onCancel) {
			signal?.removeEventListener("abort", onCancel);
		}
	}, delay ?? 1);

	if (signal) {
		onCancel = (): void => {
			clearTimeout(timer);
			reject(new AbortError(undefined, { cause: signal.reason }));
		};
		signal.addEventListener("abort", onCancel, { once: true });
	}

	return promise;
}

export async function setImmediate<T = void>(
	value?: T,
	options: TimerOptions = {},
): Promise<T> {
	validateOptions(options);
	const { signal } = options;
	if (signal?.aborted === true) {
		throw new AbortError(undefined, { cause: signal.reason });
	}

	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let onCancel: OnCancelCallback;

	const immediate = hostSetImmediate(() => {
		resolve(value as T);
		if (onCancel) {
			signal?.removeEventListener("abort", onCancel);
		}
	});

	if (signal) {
		onCancel = (): void => {
			hostClearImmediate(immediate);
			reject(new AbortError(undefined, { cause: signal.reason }));
		};
		signal.addEventListener("abort", onCancel, { once: true });
	}

	return promise;
}

export async function* setInterval<T = void>(
	delay?: number,
	value?: T,
	options: TimerOptions = {},
): AsyncGenerator<T, undefined> {
	if (delay !== undefined) {
		validateNumber(delay, "delay");
	}
	validateOptions(options);
	const { signal, ref } = options;
	if (signal?.aborted === true) {
		throw new AbortError(undefined, { cause: signal.reason });
	}

	let onCancel: OnCancelCallback;
	let interval: Timeout | undefined;
	try {
		let notYielded = 0;
		let callback: ((promise?: Promise<void>) => void) | undefined;
		// OpenOrange: the generator body runs on the first next(), which Worker code calls.
		interval = startTimerFor(setInterval, true, () => {
			notYielded++;
			callback?.();
			callback = undefined;
		}, delay ?? 1);
		if (ref === false) interval.unref();

		if (signal) {
			onCancel = (): void => {
				clearInterval(interval);
				callback?.(Promise.reject(new AbortError(undefined, { cause: signal.reason })));
				callback = undefined;
			};
			signal.addEventListener("abort", onCancel, { once: true });
		}

		// A function, so TypeScript does not keep the narrowing from before the loop.
		const aborted = (): boolean => signal?.aborted === true;
		while (!aborted()) {
			if (notYielded === 0) {
				await new Promise<void>((resolve) => (callback = resolve));
			}
			for (; notYielded > 0; notYielded--) {
				yield value as T;
			}
		}
		throw new AbortError(undefined, { cause: signal?.reason });
	} finally {
		if (interval !== undefined) {
			clearInterval(interval);
		}
		if (onCancel) {
			signal?.removeEventListener("abort", onCancel);
		}
	}
}

class Scheduler {
	[kScheduler] = true;

	yield(): Promise<void> {
		if (!this[kScheduler]) throw new ERR_INVALID_THIS("Scheduler");
		return setImmediate();
	}

	wait(delay: number, options?: SchedulerWaitOptions): Promise<void> {
		if (!this[kScheduler]) throw new ERR_INVALID_THIS("Scheduler");
		// OpenOrange: the global scheduler.wait(), with this method as the Worker's call.
		return schedulerWaitFor(Scheduler.prototype.wait, delay, options);
	}
}

export const scheduler = new Scheduler();

export default {
	scheduler,
	setImmediate,
	setInterval,
	setTimeout,
};
