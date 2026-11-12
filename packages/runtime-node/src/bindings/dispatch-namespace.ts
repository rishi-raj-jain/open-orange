import { remoteServiceBackend } from "../session/client.js";
import type { SessionWorkers } from "../session/workers.js";
import { createServiceStub } from "./service.js";

// `env.DISPATCHER` for a Workers for Platforms dispatch namespace. Locally,
// the namespace's user Workers are the other Workers of the `orange dev`
// session, found by their `name`. `args` and `options` (limits and outbound
// parameters) have no local effect.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/types/defines/dispatch-namespace.d.ts
export class DispatchNamespace {
	readonly #workers: SessionWorkers;

	constructor(workers: SessionWorkers) {
		this.#workers = workers;
	}

	get(name: string, _args?: Record<string, unknown>, _options?: unknown): object {
		if (typeof name !== "string") {
			throw new TypeError("DispatchNamespace.get() requires a Worker name");
		}
		return createServiceStub(
			remoteServiceBackend({
				entrypoint: "default",
				missing: "dispatch-namespace",
				service: name,
				workers: this.#workers,
			}),
			undefined,
		);
	}
}

export function createDispatchNamespace(workers: SessionWorkers): DispatchNamespace {
	return new DispatchNamespace(workers);
}
