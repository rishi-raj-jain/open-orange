export interface DurableObjectClassManifest {
	className: string;
}

export interface DurableObjectManifest {
	classes: readonly DurableObjectClassManifest[];
}

export type ConfiguredDurableObjectClass = abstract new (
	...args: never[]
) => object;

// Cloudflare accepts a plain class as a Durable Object. Extending
// DurableObject is only required for RPC without the js_rpc flag.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-rpc.c%2B%2B#L2303-L2310
export function isDurableObjectClass(
	value: unknown,
): value is ConfiguredDurableObjectClass {
	if (typeof value !== "function") {
		return false;
	}
	const prototype: unknown = value.prototype;
	return typeof prototype === "object" && prototype !== null;
}

export function discoverDurableObjectClasses(
	workerExports: Readonly<Record<string, unknown>>,
	manifest: DurableObjectManifest,
): ReadonlyMap<string, ConfiguredDurableObjectClass> {
	const classes = new Map<string, ConfiguredDurableObjectClass>();
	for (const configuredClass of manifest.classes) {
		if (classes.has(configuredClass.className)) {
			throw new Error(
				`Duplicate configured Durable Object class ${configuredClass.className}`,
			);
		}
		const exportedValue = workerExports[configuredClass.className];
		if (exportedValue === undefined) {
			throw new Error(
				`Configured Durable Object class ${configuredClass.className} is not a named Worker export`,
			);
		}
		if (!isDurableObjectClass(exportedValue)) {
			throw new TypeError(
				`Configured Durable Object class ${configuredClass.className} must be a class`,
			);
		}
		classes.set(configuredClass.className, exportedValue);
	}
	return classes;
}
