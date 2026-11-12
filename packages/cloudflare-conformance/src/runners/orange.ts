import { pathToFileURL } from "node:url";

import { globalImplementations } from "@open-orange/runtime-node/globals";

import { type FixtureOutcome, parseFixtureOutcome } from "./protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function runOrangeFixture(
	modulePath: string,
	testCase: string,
	env: Record<string, unknown> = {},
): Promise<FixtureOutcome> {
	const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, implementation] of Object.entries(globalImplementations)) {
		originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, {
			configurable: true,
			value: implementation,
			writable: true,
		});
	}

	try {
		const workerModule: unknown = await import(pathToFileURL(modulePath).href);
		if (!isRecord(workerModule) || !isRecord(workerModule.default)) {
			throw new Error(`Orange fixture has no default Worker export: ${modulePath}`);
		}
		const handler = workerModule.default.fetch;
		if (typeof handler !== "function") {
			throw new Error(`Orange fixture has no fetch handler: ${modulePath}`);
		}

		const response: unknown = await Reflect.apply(handler, workerModule.default, [
			new Request(`http://orange.invalid/?case=${encodeURIComponent(testCase)}`),
			env,
		]);
		if (!(response instanceof Response)) {
			throw new Error(`Orange fixture did not return a Response: ${modulePath}`);
		}
		const outcome: unknown = await response.json();
		return parseFixtureOutcome(outcome);
	} finally {
		for (const [name, descriptor] of originalDescriptors) {
			if (descriptor === undefined) {
				Reflect.deleteProperty(globalThis, name);
			} else {
				Object.defineProperty(globalThis, name, descriptor);
			}
		}
	}
}
