// The runner and the Worker bundle load separate copies of this module, so the env passes through a
// realm-wide symbol.
export const workerEnvKey = Symbol.for("open-orange.node-process.worker-env");

function isJsonSerializable(value: unknown, seen = new Set<unknown>()): boolean {
	switch (typeof value) {
		case "boolean":
		case "number":
		case "string":
			return true;
		case "object": {
			if (value === null) return true;
			if (seen.has(value)) return false;
			seen.add(value);
			const prototype: unknown = Object.getPrototypeOf(value);
			if (prototype === Object.prototype) {
				return Object.values(value).every((entry) => isJsonSerializable(entry, seen));
			}
			if (prototype === Array.prototype && Array.isArray(value)) {
				return value.every((entry: unknown) => isJsonSerializable(entry, seen));
			}
			return false;
		}
		default:
			return false;
	}
}

/**
 * Sets the `process.env` that Worker code sees, from the Worker's `env` object. Call it before the
 * Worker module evaluates. Like workerd's nodejs_compat_populate_process_env, string values stay as
 * they are, plain JSON values are JSON-stringified, and other bindings are left out.
 */
export function setWorkerProcessEnv(workerEnv: Readonly<Record<string, unknown>>): void {
	const values: Record<string, string> = {};
	for (const [key, value] of Object.entries(workerEnv)) {
		if (typeof value === "string") values[key] = value;
		else if (isJsonSerializable(value)) values[key] = JSON.stringify(value);
	}
	Reflect.set(globalThis, workerEnvKey, values);
}
