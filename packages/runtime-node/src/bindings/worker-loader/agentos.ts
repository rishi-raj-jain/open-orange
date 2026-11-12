// Runs each dynamic Worker as a Node.js process in its own agentOS VM, so two
// dynamic Workers never share a filesystem, process table, or loopback. Each
// VM boots on demand when its dynamic Worker loads.
//
// agentOS sets a VM's network policy in `AgentOs.create()` and has no API to
// change it after boot. A Worker with the default `globalOutbound` gets a VM
// with network access. A Worker with `globalOutbound: null` or a Fetcher
// outbound gets a VM with no network, since its fetch() goes over RPC to the
// parent.

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { PassThrough } from "node:stream";

import type { AgentOs } from "@rivet-dev/agentos-core";

import { onRuntimeClose } from "../../internal/close-hooks.js";
import { errorMessage, isRecord } from "../unknown-values.js";
import type { WorkerChild, WorkerHost, WorkerLoaderBackend } from "./loader.js";

// Where the child and runtime modules live inside each VM.
const runtimeRoot = "/open-orange/runtime";
const workersRoot = "/open-orange/workers";
const exitWaitMs = 5_000;

type NetworkMode = "deny" | "network";

interface BootedVm {
	moduleRewrites: Record<string, string>;
	vm: AgentOs;
}

// A VM that is booting or booted. `dispose` runs once.
interface OwnedVm {
	booted: Promise<BootedVm>;
	dispose(): Promise<void>;
}

async function listFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => posix.join(entry.parentPath.slice(directory.length).split("\\").join("/"), entry.name));
}

function bootError(error: unknown): Error {
	const message = errorMessage(error);
	return new Error(
		`OpenOrange cannot boot the agentOS VM for a dynamic Worker: ${message}. Dynamic Workers never run on the host.`,
		{ cause: error },
	);
}


// agentOS writes one file into the VM as one message to its sidecar. In a test with agentOS 0.4.1,
// a 15 MiB file wrote and a 16.5 MiB file crashed the sidecar, which then failed every Dynamic
// Worker of the session. A larger file fails here with the limit instead. The VM filesystem
// itself holds 64 MiB by default, Orange's runtime files included.
const agentOsFileMessageBytes = 16 * 1024 * 1024;

function assertFitsAgentOsFileMessage(path: string, content: string | Uint8Array): void {
	const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
	if (bytes <= agentOsFileMessageBytes) return;
	throw new RangeError(
		`Dynamic Worker file ${posix.basename(path)} is ${bytes} bytes. agentOS writes one file into its VM as one message of at most ${agentOsFileMessageBytes} bytes (16 MiB). Split the module.`,
	);
}
export class AgentOsWorkerLoaderBackend implements WorkerLoaderBackend {
	readonly #bundlePath: () => string;
	readonly #vms = new Set<OwnedVm>();
	readonly #children = new Set<{ exited: Promise<void>; kill(): void }>();
	#closed = false;

	// The bundle path resolves at boot, so a missing bundle fails the first
	// dynamic Worker instead of runtime startup.
	constructor(bundlePath: () => string) {
		this.#bundlePath = bundlePath;
		// Each VM owns a sidecar process, so stop every child and dispose the
		// VMs when the runtime stops.
		onRuntimeClose(() => this.#close());
	}

	async open(network: boolean): Promise<WorkerHost> {
		if (this.#closed) throw new Error("The Worker Loader has stopped.");
		const owned = this.#boot(network ? "network" : "deny");
		let booted: BootedVm;
		try {
			booted = await owned.booted;
		} catch (error: unknown) {
			await owned.dispose();
			throw bootError(error);
		}
		const { moduleRewrites, vm } = booted;
		const root = posix.join(workersRoot, randomUUID());
		const children = this.#children;
		return {
			moduleRewrites,
			remove: () => owned.dispose(),
			root,
			spawn: async () => {
				const child = await spawnVmChild(vm, root);
				const entry = { exited: child.exited, kill: () => child.kill() };
				children.add(entry);
				void child.exited.then(() => children.delete(entry));
				if (this.#closed) child.kill();
				return child;
			},
			async writeFiles(files): Promise<void> {
				for (const file of files) assertFitsAgentOsFileMessage(file.path, file.content);
				const results = await vm.filesystem.writeFiles(
					files.map((file) => ({ content: file.content, path: file.path })),
				);
				const failed = results.find((result) => !result.success);
				if (failed !== undefined) {
					throw new Error(`Failed to write ${failed.path} into the agentOS VM: ${failed.error ?? "unknown error"}`);
				}
			},
		};
	}

	#boot(mode: NetworkMode): OwnedVm {
		const booted = this.#create(mode);
		let disposed: Promise<void> | undefined;
		const owned: OwnedVm = {
			booted,
			dispose: () => {
				disposed ??= (async () => {
					this.#vms.delete(owned);
					const vm = await booted.then(({ vm: value }) => value).catch(() => undefined);
					await vm?.dispose().catch(() => undefined);
				})();
				return disposed;
			},
		};
		this.#vms.add(owned);
		return owned;
	}

	async #create(mode: NetworkMode): Promise<BootedVm> {
		const bundlePath = this.#bundlePath();
		const { AgentOs } = await import("@rivet-dev/agentos-core");
		const vm = await AgentOs.create({
			permissions: { network: mode === "network" ? "allow" : "deny" },
		});
		try {
			const files = await listFiles(bundlePath);
			const entries = await Promise.all(
				files.map(async (file) => ({
					content: await readFile(join(bundlePath, file)),
					path: posix.join(runtimeRoot, file),
				})),
			);
			const results = await vm.filesystem.writeFiles(entries);
			const failed = results.find((result) => !result.success);
			if (failed !== undefined) {
				throw new Error(`Failed to write ${failed.path} into the agentOS VM: ${failed.error ?? "unknown error"}`);
			}
			const manifest: unknown = JSON.parse(
				await readFile(join(bundlePath, "manifest.json"), "utf8"),
			);
			if (!isRecord(manifest)) throw new Error("The agentOS runtime bundle manifest must be an object");
			const moduleRewrites = Object.fromEntries(
				Object.entries(manifest).map(([specifier, file]) => {
					if (typeof file !== "string") {
						throw new Error(`The agentOS runtime bundle manifest maps ${specifier} to a non-string file`);
					}
					return [specifier, posix.join(runtimeRoot, file)];
				}),
			);
			return { moduleRewrites, vm };
		} catch (error: unknown) {
			await vm.dispose();
			throw error;
		}
	}

	async #close(): Promise<void> {
		this.#closed = true;
		// Disposing a VM with a running process fails to observe its exit, so
		// stop the children first.
		const children = [...this.#children];
		for (const child of children) child.kill();
		await Promise.race([
			Promise.all(children.map((child) => child.exited)),
			new Promise((resolveWait) => setTimeout(resolveWait, exitWaitMs).unref()),
		]);
		await Promise.all([...this.#vms].map((owned) => owned.dispose()));
	}
}

async function spawnVmChild(
	vm: AgentOs,
	root: string,
): Promise<WorkerChild & { exited: Promise<void> }> {
	const stdout = new PassThrough();
	const exitListeners: ((reason: string) => void)[] = [];
	let exitReason: string | undefined;
	const descriptor = await vm.process.spawn("node", [posix.join(runtimeRoot, "worker-loader-child.mjs")], {
		cwd: root,
		env: { HOME: "/home/user", PATH: "/usr/local/bin:/usr/bin:/bin" },
		onStderr: (chunk) => process.stderr.write(chunk),
		onStdout: (chunk) => stdout.write(chunk),
	});
	const pid = descriptor.pid;
	const exited = vm.process.wait(pid).then(
		(exit) => {
			exitReason =
				exit.outcome === "signalled"
					? `signal ${exit.signal ?? "unknown"}`
					: exit.outcome === "timed_out"
						? "timed out"
						: `code ${exit.exitCode ?? "none"}`;
		},
		(error: unknown) => {
			exitReason = `lost: ${errorMessage(error)}`;
		},
	);
	const done = exited.then(() => {
		stdout.end();
		for (const listener of exitListeners.splice(0)) listener(exitReason ?? "unknown");
	});
	// The VM takes stdin writes in order only if each waits for the last.
	let writes = Promise.resolve();
	return {
		exited: done,
		kill(): void {
			if (exitReason !== undefined) return;
			vm.process.signal(pid, "SIGKILL").catch(() => undefined);
		},
		onExit(listener): void {
			if (exitReason !== undefined) listener(exitReason);
			else exitListeners.push(listener);
		},
		stdout,
		write(text): void {
			if (exitReason !== undefined) return;
			writes = writes.then(() => vm.process.writeStdin(pid, text)).catch(() => undefined);
		},
	};
}
