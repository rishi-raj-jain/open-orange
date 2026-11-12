import type { RuntimeBindingConfiguration } from "../process-protocol.js";

// Orange's runtime reads its own settings, such as ORANGE_R2_<BUCKET>_S3_*, ORANGE_SANDBOX_PROVIDER
// or E2B_API_KEY, from the host environment and from the Worker's vars, so `.dev.vars` and `.env`
// can hold them. The Worker's vars stay out of the real process.env, which Worker code no longer
// sees. Runtime modules that the Worker bundle loads are separate copies of this file, so the vars
// pass through a global. They hold only values that the Worker's own env already has.
const workerVarsKey = Symbol.for("open-orange.runtime-settings.worker-vars");

export type RuntimeSettings = Readonly<Record<string, string | undefined>>;

// workerd fills the Worker's process.env the same way: strings stay as they are and JSON values
// are stringified.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_process.ts#L98-L137
export function workerVarSettings(
	bindings: readonly { readonly binding: string; readonly type: string; readonly value?: unknown }[],
): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const binding of bindings) {
		if (binding.type === "plain_text" && typeof binding.value === "string") {
			vars[binding.binding] = binding.value;
		} else if (binding.type === "json") {
			vars[binding.binding] =
				typeof binding.value === "string" ? binding.value : JSON.stringify(binding.value);
		}
	}
	return vars;
}

export function publishWorkerVarSettings(bindings: readonly RuntimeBindingConfiguration[]): void {
	Reflect.set(globalThis, workerVarsKey, Object.freeze(workerVarSettings(bindings)));
}

/** `environment` with the Worker's vars over it. For `ORANGE_*` settings the environment wins. */
export function mergeRuntimeSettings(
	environment: Readonly<Record<string, string | undefined>>,
	vars: Readonly<Record<string, unknown>>,
): RuntimeSettings {
	const settings: Record<string, string | undefined> = { ...environment };
	for (const [name, value] of Object.entries(vars)) {
		if (typeof value !== "string") continue;
		if (name.startsWith("ORANGE_") && environment[name] !== undefined) continue;
		settings[name] = value;
	}
	return settings;
}

/** The host environment with the Worker's vars over it. For `ORANGE_*` settings the shell wins. */
export function runtimeSettings(): RuntimeSettings {
	const vars: unknown = Reflect.get(globalThis, workerVarsKey);
	if (typeof vars !== "object" || vars === null) return { ...process.env };
	return mergeRuntimeSettings(process.env, vars as Record<string, unknown>);
}
