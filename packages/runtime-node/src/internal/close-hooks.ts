// Cleanup that must run when the runtime stops. Replaced modules such as
// `@cloudflare/sandbox` load as separate bundles, so the hooks live on a
// process-global key instead of in one module instance.
const closeHooksKey: unique symbol = Symbol.for("open-orange.runtime.close-hooks");

type CloseHook = () => Promise<void>;

interface CloseHookStore {
	[closeHooksKey]?: Set<CloseHook>;
}

function closeHooks(): Set<CloseHook> {
	const store: CloseHookStore & typeof globalThis = globalThis;
	let hooks = store[closeHooksKey];
	if (hooks === undefined) {
		hooks = new Set();
		store[closeHooksKey] = hooks;
	}
	return hooks;
}

/** Runs `hook` when the runtime stops. Returns a function that removes it. */
export function onRuntimeClose(hook: CloseHook): () => void {
	closeHooks().add(hook);
	return () => closeHooks().delete(hook);
}

/** Runs every close hook once. A failing hook does not stop the others. */
export async function runRuntimeCloseHooks(): Promise<PromiseSettledResult<void>[]> {
	const hooks = [...closeHooks()];
	closeHooks().clear();
	return Promise.allSettled(hooks.map((hook) => hook()));
}
