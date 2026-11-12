import { AsyncLocalStorage } from "node:async_hooks";

interface Override {
	value: unknown;
}

interface ImportableWorkerScope {
	baseEnv?: object;
	baseExports?: object;
	env: AsyncLocalStorage<Override>;
	exports: AsyncLocalStorage<Override>;
}

// The runtime and the packaged cloudflare:workers bundle are separate module
// instances, so they share the Worker scope through one process-global slot.
const scopeKey = Symbol.for("open-orange.runtime.cloudflare-workers.scope");

function isImportableWorkerScope(value: unknown): value is ImportableWorkerScope {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "env") instanceof AsyncLocalStorage &&
		Reflect.get(value, "exports") instanceof AsyncLocalStorage
	);
}

function importableWorkerScope(): ImportableWorkerScope {
	const existing: unknown = Reflect.get(globalThis, scopeKey);
	if (isImportableWorkerScope(existing)) return existing;
	const scope: ImportableWorkerScope = {
		env: new AsyncLocalStorage(),
		exports: new AsyncLocalStorage(),
	};
	Object.defineProperty(globalThis, scopeKey, { value: scope });
	return scope;
}

export function setImportableWorkerEnv(env: object): void {
	importableWorkerScope().baseEnv = env;
}

export function setImportableWorkerExports(exports: object): void {
	importableWorkerScope().baseExports = exports;
}

/** The Worker's ctx.exports, or undefined before the Worker loads. */
export function workerContextExports(): object | undefined {
	return importableWorkerScope().baseExports;
}

// An object override wins, null or undefined hides the base value, and any
// other override falls back to the base value.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/modules.c%2B%2B#L9-L28
function currentTarget(
	storage: AsyncLocalStorage<Override>,
	base: object | undefined,
): object | undefined {
	const override = storage.getStore();
	if (override === undefined) return base;
	const { value } = override;
	if ((typeof value === "object" && value !== null) || typeof value === "function") {
		return value;
	}
	return value === null || value === undefined ? undefined : base;
}

const currentEnv = (): object | undefined => {
	const scope = importableWorkerScope();
	return currentTarget(scope.env, scope.baseEnv);
};

const currentExports = (): object | undefined => {
	const scope = importableWorkerScope();
	return currentTarget(scope.exports, scope.baseExports);
};

export function withEnv<Result>(newEnv: unknown, fn: () => Result): Result {
	return importableWorkerScope().env.run({ value: newEnv }, fn);
}

export function withExports<Result>(newExports: unknown, fn: () => Result): Result {
	return importableWorkerScope().exports.run({ value: newExports }, fn);
}

export function withEnvAndExports<Result>(
	newEnv: unknown,
	newExports: unknown,
	fn: () => Result,
): Result {
	return withEnv(newEnv, () => withExports(newExports, fn));
}

// The env and exports proxies delegate to the current Worker scope so that a
// module-level import follows withEnv() and withExports() overrides.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/workers.ts#L39-L154
export const env: Record<string, unknown> = new Proxy(
	{},
	{
		defineProperty: (_target, property, attributes) => {
			const inner = currentEnv();
			return inner === undefined ? true : Reflect.defineProperty(inner, property, attributes);
		},
		deleteProperty: (_target, property) => {
			const inner = currentEnv();
			return inner === undefined ? true : Reflect.deleteProperty(inner, property);
		},
		get: (_target, property) => {
			const inner = currentEnv();
			return inner === undefined ? undefined : Reflect.get(inner, property);
		},
		// The proxy target is an empty extensible object, so a descriptor must be
		// configurable to satisfy the Proxy invariants.
		getOwnPropertyDescriptor: (_target, property) => {
			const inner = currentEnv();
			const descriptor =
				inner === undefined ? undefined : Reflect.getOwnPropertyDescriptor(inner, property);
			return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
		},
		has: (_target, property) => {
			const inner = currentEnv();
			return inner === undefined ? false : Reflect.has(inner, property);
		},
		ownKeys: () => {
			const inner = currentEnv();
			return inner === undefined ? [] : Reflect.ownKeys(inner);
		},
		set: (_target, property, value) => {
			const inner = currentEnv();
			return inner === undefined ? true : Reflect.set(inner, property, value);
		},
	},
);

export const exports: Record<string, unknown> = new Proxy(
	{},
	{
		get: (_target, property) => {
			const inner = currentExports();
			return inner === undefined ? undefined : Reflect.get(inner, property);
		},
		getOwnPropertyDescriptor: (_target, property) => {
			const inner = currentExports();
			const descriptor =
				inner === undefined ? undefined : Reflect.getOwnPropertyDescriptor(inner, property);
			return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
		},
		has: (_target, property) => {
			const inner = currentExports();
			return inner === undefined ? false : Reflect.has(inner, property);
		},
		ownKeys: () => {
			const inner = currentExports();
			return inner === undefined ? [] : Reflect.ownKeys(inner);
		},
	},
);
