import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fetch as undiciFetch } from "undici";

// Rivet Services hosts Durable Streams, which Tail Workers use. Orange starts it beside a local
// Engine, as it starts the Engine, with the contract of RivetKit's own Services spawner.
// https://github.com/rivet-dev/rivet/blob/9e01a0ac67/rivetkit-rust/packages/rivetkit-core/src/services_process.rs#L101-L160
export const servicesPoolName = "services";

const readinessTimeoutMs = 30_000;
const stopTimeoutMs = 2_000;

// Runs the Services binary as a child of a shell guard. The guard holds this process's end of a
// pipe on fd 3: when this process exits for any reason, SIGKILL included, the pipe closes and the
// guard kills Services. Closing the pipe is also the normal stop, because Services 0.2.5 ignores
// SIGTERM. Its streams commit each write, so the kill loses nothing.
const guardScript = `exec 3<&0
"$@" </dev/null &
child=$!
{ read -r _ <&3; kill -KILL "$child" 2>/dev/null; } &
reader=$!
wait "$child"
status=$?
kill "$reader" 2>/dev/null
exit "$status"`;

export class ServicesUnavailableError extends Error {
	override name = "ServicesUnavailableError";
}

/**
 * The `rivet-services` binary of the `@rivet-dev/services` package that the pinned RivetKit
 * depends on. RIVET_SERVICES_BINARY overrides it.
 */
export function resolveServicesBinary(rivetKitEntrypoint: string): string {
	try {
		const services: unknown = createRequire(rivetKitEntrypoint)("@rivet-dev/services");
		const getServicesPath: unknown =
			typeof services === "object" && services !== null ? Reflect.get(services, "getServicesPath") : undefined;
		if (typeof getServicesPath !== "function") throw new Error("@rivet-dev/services has no getServicesPath()");
		const path: unknown = getServicesPath();
		if (typeof path !== "string") throw new Error("@rivet-dev/services returned no binary path");
		return path;
	} catch (error: unknown) {
		throw new ServicesUnavailableError(
			"tail_consumers needs Rivet Services, which hosts the Durable Streams that carry tail events, " +
				"and its binary is unavailable. Install @rivet-dev/services with optional dependencies, " +
				"or set RIVET_SERVICES_BINARY to a rivet-services executable.\n" +
				(error instanceof Error ? error.message : String(error)),
			{ cause: error },
		);
	}
}

export interface StartServicesOptions {
	binaryPath: string;
	endpoint: string;
	logDirectory: string;
	namespace: string;
	token: string;
}

export interface ServicesProcess {
	/** Resolves once the Engine lists a node in the `services` pool. */
	readonly ready: Promise<void>;
	stop(): Promise<void>;
}

async function servicesPoolHasNode(options: StartServicesOptions): Promise<boolean> {
	const url = new URL(`/pools/${servicesPoolName}/nodes`, options.endpoint);
	url.searchParams.set("namespace", options.namespace);
	url.searchParams.set("limit", "1");
	try {
		const response = await undiciFetch(url, { headers: { authorization: `Bearer ${options.token}` } });
		if (!response.ok) {
			await response.body?.cancel();
			return false;
		}
		const body: unknown = await response.json();
		const nodes = typeof body === "object" && body !== null ? Reflect.get(body, "nodes") : undefined;
		return Array.isArray(nodes) && nodes.length > 0;
	} catch {
		return false;
	}
}

export function startServices(options: StartServicesOptions): ServicesProcess {
	mkdirSync(options.logDirectory, { recursive: true });
	const log = openSync(join(options.logDirectory, `services-${new Date().toISOString().replaceAll(":", "-")}.log`), "a");
	const child: ChildProcess = spawn("sh", ["-c", guardScript, "rivet-services-guard", options.binaryPath, "start"], {
		env: {
			...process.env,
			// Orange calls streams through the Engine gateway, never through the HTTP facade, so the
			// facade takes any free port and sessions do not share 8642.
			HOST: "127.0.0.1",
			PORT: "0",
			RIVETKIT_ENGINE_SPAWN: "never",
			RIVET_ENDPOINT: options.endpoint,
			RIVET_NAMESPACE: options.namespace,
			RIVET_POOL: servicesPoolName,
			RIVET_RUN_SERVICES: "0",
			RIVET_TOKEN: options.token,
		},
		stdio: ["pipe", log, log],
	});
	// The pipe and the child must not keep this process alive.
	child.unref();
	const stdin = child.stdin as (NodeJS.WritableStream & { unref?(): void }) | null;
	stdin?.unref?.();
	const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
	let alive = true;
	void exited.then(() => {
		alive = false;
	});
	const ready = (async () => {
		const deadline = Date.now() + readinessTimeoutMs;
		while (!(await servicesPoolHasNode(options))) {
			if (!alive) {
				throw new Error(`Rivet Services exited during startup. Its log is in ${options.logDirectory}.`);
			}
			if (Date.now() > deadline) {
				throw new Error(`Rivet Services did not join the Engine within ${readinessTimeoutMs / 1_000} s. Its log is in ${options.logDirectory}.`);
			}
			await delay(100);
		}
	})();
	return {
		ready,
		async stop(): Promise<void> {
			if (!alive) return;
			child.stdin?.end();
			await Promise.race([exited, delay(stopTimeoutMs)]);
			if (alive) child.kill("SIGKILL");
		},
	};
}
