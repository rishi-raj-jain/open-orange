import { globalManifest } from "./manifest.js";
import { installAbortReasonDefaults } from "./abort.js";
import { installBufferPatches } from "./buffer.js";
import { globalImplementations } from "./implementations.js";
import { installGlobalScopeEvents } from "./global-scope.js";
import { installReadAtLeast } from "./identity-transform-stream.js";
import { installPerformanceEntryJson } from "./native.js";
import { installFileInspect, nodeWebGlobals } from "./node-web.js";
import { createUnimplementedGlobal } from "./unimplemented.js";

function valueForGlobal(name: string, target: object): unknown {
	if (name === "self") return target;
	if (Object.hasOwn(globalImplementations, name)) {
		return Reflect.get(globalImplementations, name);
	}
	// Keep a host global that Node already provides, such as the streams
	// queuing strategies, instead of shadowing it with a throwing placeholder.
	const hostValue: unknown = Reflect.get(target, name);
	return hostValue === undefined ? createUnimplementedGlobal(name) : hostValue;
}

export function installCloudflareGlobals(target: object = globalThis): void {
	for (const entry of globalManifest) {
		// The agentOS VM locks a few globals. TextDecoder, TextEncoder, and
		// Buffer can only be assigned, and its WebSocket cannot be replaced.
		const existing = Object.getOwnPropertyDescriptor(target, entry.name);
		if (existing?.configurable === false) {
			if (existing.writable === true) Reflect.set(target, entry.name, valueForGlobal(entry.name, target));
			continue;
		}
		Object.defineProperty(target, entry.name, {
			configurable: true,
			enumerable: false,
			value: valueForGlobal(entry.name, target),
			writable: true,
		});
	}
	if (target === globalThis) {
		installAbortReasonDefaults();
		installGlobalScopeEvents();
		installReadAtLeast(nodeWebGlobals.ReadableStreamBYOBReader);
		installPerformanceEntryJson();
		installFileInspect();
		installBufferPatches();
	}
}

export async function installCloudflareGlobalsBeforeImport<Result>(
	importWorker: () => Promise<Result>,
	target: object = globalThis,
): Promise<Result> {
	installCloudflareGlobals(target);
	return importWorker();
}
