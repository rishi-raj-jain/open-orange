export interface EnvironmentBinding {
	name: string;
	value: unknown;
}

export function createEnvironment(
	bindings: Iterable<EnvironmentBinding>,
): Record<string, unknown> {
	const environment: Record<string, unknown> = {};
	for (const binding of bindings) {
		if (binding.name.length === 0) {
			throw new Error("Worker environment binding names cannot be empty");
		}
		if (Object.hasOwn(environment, binding.name)) {
			throw new Error(
				`Duplicate Worker environment binding ${JSON.stringify(binding.name)}`,
			);
		}
		Object.defineProperty(environment, binding.name, {
			configurable: true,
			enumerable: true,
			value: binding.value,
			writable: true,
		});
	}
	return environment;
}
