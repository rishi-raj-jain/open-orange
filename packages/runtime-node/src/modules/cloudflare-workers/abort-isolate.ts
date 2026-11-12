// A dynamic Worker's process sets this to a function that ends the process, so the Worker Loader
// starts a fresh isolate on the next get().
export const abortIsolateHook = Symbol.for("open-orange.abort-isolate");

/**
 * Ends the isolate that runs the calling Worker, like workerd's `abortIsolate()`. The call that
 * aborts, and every other call in flight on that isolate, fails with an internal error.
 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/worker-loader-test.js#L1045-L1101
 */
export function abortIsolate(reason?: unknown): never {
	const hook: unknown = Reflect.get(globalThis, abortIsolateHook);
	if (typeof hook === "function") hook(String(reason ?? ""));
	throw new Error(
		"OpenOrange supports abortIsolate() only in a dynamic Worker that a Worker Loader started.",
	);
}
