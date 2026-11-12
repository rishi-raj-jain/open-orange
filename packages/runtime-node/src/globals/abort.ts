import { defineEventHandlerAttribute } from "./global-scope.js";
import { AbortController, AbortSignal } from "./native.js";

function defaultAbortReason(): DOMException {
	return new DOMException("The operation was aborted", "AbortError");
}

// workerd turns an abort reason into a native exception when the signal
// aborts. For an object reason it reads `overloaded`, then `retryable`, once
// per abort, and a getter that throws propagates out of abort().
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/jsg/value.h#L1427-L1440
function deriveAbortException(reason: unknown): void {
	if ((typeof reason !== "object" || reason === null) && typeof reason !== "function") return;
	if (!Reflect.get(reason, "overloaded")) Reflect.get(reason, "retryable");
}

// Signals whose abort reason is being derived. An abort() that arrives while
// a reason getter runs finds the latch set and does nothing.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L951-L969
const aborting = new WeakSet<AbortSignal>();

let installed = false;

// workerd aborts with "The operation was aborted" when no reason is given,
// while Node uses "This operation was aborted".
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L633-L655
export function installAbortReasonDefaults(): void {
	if (installed) return;
	installed = true;
	const nodeAbort = AbortController.prototype.abort;
	AbortController.prototype.abort = function (this: AbortController, reason?: unknown): void {
		const signal = this.signal;
		if (signal.aborted || aborting.has(signal)) return;
		const value = reason === undefined ? defaultAbortReason() : reason;
		aborting.add(signal);
		try {
			deriveAbortException(value);
		} finally {
			aborting.delete(signal);
		}
		Reflect.apply(nodeAbort, this, [value]);
	};
	defineEventHandlerAttribute(AbortSignal.prototype, "abort");
	const nodeSignalAbort = AbortSignal.abort;
	AbortSignal.abort = function (reason?: unknown): AbortSignal {
		const value = reason === undefined ? defaultAbortReason() : reason;
		deriveAbortException(value);
		return Reflect.apply(nodeSignalAbort, AbortSignal, [value]);
	};
}
