import type {
	RuntimeInternalAddress,
	RuntimeSessionConfiguration,
	RuntimeSessionWorker,
} from "../process-protocol.js";

// The Rivet envoy pool of a Worker that runs alone or first in `orange dev`.
// Actors keep the pool they were created in, so it stays RivetKit's default.
export const primaryRivetPoolName = "default";

// Wrangler's dev registry text for a Worker that is not running. A service
// binding's fetch() answers 503 with it, and its RPC calls throw it.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/core/dev-registry-proxy-shared.worker.ts#L121-L126
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/core/dev-registry-proxy.worker.ts#L165-L221
export function workerNotFoundMessage(name: string): string {
	return `Worker "${name}" not found. Make sure it is running locally.`;
}

export interface ReachableSessionWorker extends RuntimeSessionWorker {
	internalAddress: RuntimeInternalAddress;
}

// The other Workers of this runtime's `orange dev` session.
export class SessionWorkers {
	readonly #configuration: RuntimeSessionConfiguration | undefined;
	#workers: Map<string, RuntimeSessionWorker>;

	constructor(configuration: RuntimeSessionConfiguration | undefined) {
		this.#configuration = configuration;
		this.#workers = new Map(
			(configuration?.workers ?? []).map((worker) => [worker.name, worker]),
		);
	}

	get token(): string {
		return this.#configuration?.token ?? "";
	}

	update(workers: readonly RuntimeSessionWorker[]): void {
		this.#workers = new Map(workers.map((worker) => [worker.name, worker]));
	}

	// A Worker of the session, whether or not its runtime is ready yet.
	configured(name: string): RuntimeSessionWorker | undefined {
		return this.#workers.get(name);
	}

	// A Worker of the session whose runtime accepts calls.
	reachable(name: string): ReachableSessionWorker | undefined {
		const worker = this.#workers.get(name);
		if (worker?.internalAddress === undefined) return undefined;
		return { ...worker, internalAddress: worker.internalAddress };
	}
}

// Cron triggers belong to one Worker, and the Workers of a multi-Worker session
// share one Engine, so each appends its name to its cron actor key. A Worker
// that runs alone keeps the unscoped key, so its existing local data still routes.
// Queues and Workflows are shared by name across the session, as on Cloudflare.
export function cronActorKeyScope(
	configuration: RuntimeSessionConfiguration | undefined,
): readonly string[] {
	if (configuration === undefined || configuration.workers.length < 2) return [];
	if (configuration.self === undefined) {
		throw new Error("A Worker of a multi-Worker session must have a name");
	}
	return [configuration.self];
}
