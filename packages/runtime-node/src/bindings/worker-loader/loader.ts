// `env.LOADER` for a `worker_loaders` binding. Dynamic Worker code is
// untrusted, so each one runs as a Node.js process in an agentOS VM, never on
// the host. It shares no globals, module state, or env with the parent
// Worker. Workers RPC between the processes uses Cap'n Web over framed stdio.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";

import { Request, type RequestInfo, type RequestInit } from "../../globals/http.js";
import { URL } from "../../globals/url.js";
import { createStub, type CallOutcome, type Capability } from "../../rpc/loopback.js";
import { linkModules, type DynamicModule, type DynamicModuleType } from "./modules.js";
import {
	decodeLoaderReply,
	encodeLoaderValue,
	FramedRpcTransport,
	openLoaderSession,
	readFrames,
	RemoteCapability,
} from "./session.js";
import type { CapnWebStub } from "../durable-objects/rpc/capnweb.js";
import { isRecord } from "../unknown-values.js";

export interface WorkerFile {
	content: string | Uint8Array;
	path: string;
}

// A running dynamic Worker process. Stdin and stdout carry the framed RPC
// stream.
export interface WorkerChild {
	readonly stdout: Readable;
	write(text: string): void;
	kill(): void;
	// `reason` reads like "code 1" or "signal SIGKILL".
	onExit(listener: (reason: string) => void): void;
}

// The agentOS VM that hosts one dynamic Worker.
export interface WorkerHost {
	readonly root: string;
	// Where the dynamic Worker imports each runtime module from.
	readonly moduleRewrites: Readonly<Record<string, string>>;
	writeFiles(files: readonly WorkerFile[]): Promise<void>;
	spawn(): Promise<WorkerChild>;
	// Disposes the VM. Runs when the process exits or fails to start.
	remove(): Promise<void>;
}

// Where dynamic Worker processes run. `network` is false for
// `globalOutbound: null` or a Fetcher, which never need direct network access.
export interface WorkerLoaderBackend {
	open(network: boolean): Promise<WorkerHost>;
}

export interface WorkerLoaderOptions {
	backend: WorkerLoaderBackend;
	onDiagnostic(message: string): void;
}

// Workerd caps a Dynamic Worker's code at 64 MiB and its env at 1 MiB. Those are Cloudflare quotas,
// which Orange does not copy.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-loader.c%2B%2B#L14-L22

const NativeWasmModule: Function = Reflect.get(Reflect.get(globalThis, "WebAssembly"), "Module");

const moduleKeys = ["js", "cjs", "text", "data", "json", "py", "wasm"] as const;

function pythonUnsupported(): TypeError {
	return new TypeError(
		"OpenOrange does not support Python dynamic Workers. Load JavaScript modules instead.",
	);
}

function copyBytes(value: unknown, name: string): Uint8Array {
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
	}
	if (value instanceof NativeWasmModule) {
		throw new TypeError(
			`OpenOrange cannot send the compiled WebAssembly.Module "${name}" to a dynamic Worker process. Pass its bytes as { wasm: ArrayBuffer } instead.`,
		);
	}
	throw new TypeError(`Module "${name}" must contain an ArrayBuffer or ArrayBufferView.`);
}

// Mirrors workerd's extractSource(): a string module's type comes from its
// name, and an object module names its type with exactly one key.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-loader.c%2B%2B#L227-L368
function normalizeModules(mainModule: string, modules: unknown): DynamicModule[] {
	if (!isRecord(modules)) throw new TypeError("Dynamic Worker code must have a modules object.");
	const entries = Object.entries(modules);
	if (entries.length === 0) {
		throw new TypeError("Dynamic Worker code must contain at least one module.");
	}
	const pythonMain = mainModule.endsWith(".py");
	const result: DynamicModule[] = [];
	let totalSize = 0;
	const add = (name: string, type: DynamicModuleType, content: string | Uint8Array): void => {
		totalSize += typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
		result.push({ content, name, type });
	};
	for (const [name, value] of entries) {
		const normalized = posix.normalize(name);
		if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
			throw new TypeError(`Module name ${JSON.stringify(name)} is outside the Worker bundle.`);
		}
		if (typeof value === "string") {
			if (name.endsWith(".py")) {
				if (!pythonMain) {
					throw new TypeError(
						`Module "${name}" is a Python module, but the main module isn't a Python module.`,
					);
				}
				throw pythonUnsupported();
			}
			if (name.endsWith(".js")) {
				add(name, "esm", value);
				continue;
			}
			const generic = `Module name must end with '.js' or '.py' (or the content must be an object indicating the type explicitly). Got: ${name}`;
			if (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".jsx")) {
				throw new TypeError(
					`${generic}. If you're trying to load TypeScript, bundle it first with '@cloudflare/worker-bundler' and pass the generated JavaScript modules.`,
				);
			}
			throw new TypeError(generic);
		}
		if (value instanceof NativeWasmModule) {
			copyBytes(value, name);
		}
		if (!isRecord(value)) {
			throw new TypeError(`Module "${name}" must be a string or a module object.`);
		}
		const present = moduleKeys.filter((key) => value[key] !== undefined);
		if (present.length !== 1) {
			throw new TypeError(
				`Each module must contain exactly one of 'js', 'cjs', 'text', 'data', 'json', 'py', or 'wasm'. Module '${name}' contained ${present.length} properties.`,
			);
		}
		const key = present[0];
		const content = value[key ?? "js"];
		switch (key) {
			case "js":
			case "cjs":
			case "text":
				if (typeof content !== "string") {
					throw new TypeError(`Module "${name}" property '${key}' must be a string.`);
				}
				add(name, key === "js" ? "esm" : key, content);
				break;
			case "json":
				add(name, "json", JSON.stringify(content));
				break;
			case "data":
				add(name, "data", copyBytes(content, name));
				break;
			case "wasm":
				add(name, "wasm", copyBytes(content, name));
				break;
			case "py":
				if (!pythonMain) {
					throw new TypeError(
						`Module "${name}" is a Python module, but the main module isn't a Python module.`,
					);
				}
				throw pythonUnsupported();
			case undefined:
				throw new TypeError(`Module "${name}" is empty.`);
		}
	}
	if (pythonMain) throw pythonUnsupported();
	if (!result.some((module) => module.name === mainModule)) {
		throw new TypeError(`Main module "${mainModule}" is not in the modules object.`);
	}
	return result;
}

interface PreparedCode {
	env: unknown;
	mainModule: string;
	modules: DynamicModule[];
	outbound: unknown;
}

function prepareCode(code: unknown): PreparedCode {
	if (!isRecord(code)) throw new TypeError("Dynamic Worker code must be an object.");
	if (typeof code.compatibilityDate !== "string") {
		throw new TypeError("Dynamic Worker code must have a compatibilityDate string.");
	}
	if (typeof code.mainModule !== "string") {
		throw new TypeError("Dynamic Worker code must have a mainModule string.");
	}
	const modules = normalizeModules(code.mainModule, code.modules);
	const env = code.env ?? {};
	if (!isRecord(env)) throw new TypeError("Dynamic Worker env must be an object.");
	let outbound: unknown;
	if (code.globalOutbound === undefined) outbound = "network";
	else if (code.globalOutbound === null) outbound = "blocked";
	else outbound = code.globalOutbound;
	return { env, mainModule: code.mainModule, modules, outbound };
}

interface RunningWorker {
	child: WorkerChild;
	main: CapnWebStub;
}

// One loaded dynamic Worker: workerd's WorkerStubImpl. The process starts as
// soon as the Worker is requested, and calls wait for it.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L5225-L5276
class DynamicWorker {
	readonly #getCode: () => Promise<PreparedCode>;
	readonly #label: string;
	readonly #onExit: () => void;
	readonly #options: WorkerLoaderOptions;
	readonly #running: Promise<RunningWorker>;
	#abortReason: string | undefined;
	#child: WorkerChild | undefined;
	#exited = false;
	#terminated = false;

	constructor(
		label: string,
		getCode: () => Promise<PreparedCode>,
		options: WorkerLoaderOptions,
		onExit: () => void,
	) {
		this.#getCode = getCode;
		this.#label = label;
		this.#onExit = onExit;
		this.#options = options;
		this.#running = this.#start();
		this.#running.catch(() => undefined);
	}

	// Settles when the process has loaded the Worker or failed to.
	get ready(): Promise<unknown> {
		return this.#running;
	}

	async #start(): Promise<RunningWorker> {
		let host: WorkerHost | undefined;
		try {
			const prepared = await this.#getCode();
			host = await this.#options.backend.open(prepared.outbound === "network");
			const bundleRoot = posix.join(host.root, "bundle");
			const moduleRoot = posix.join(host.root, "modules");
			const files: WorkerFile[] = prepared.modules.map((module) => ({
				content: module.content,
				path: posix.join(bundleRoot, module.name),
			}));
			const linked = await linkModules(prepared.modules, prepared.mainModule, host.moduleRewrites);
			for (const [file, source] of linked.files) {
				files.push({ content: source, path: posix.join(moduleRoot, file) });
			}
			await host.writeFiles(files);
			const envelope = encodeLoaderValue({
				bundleRoot,
				env: prepared.env,
				mainFile: linked.mainFile,
				moduleNames: linked.moduleNames,
				moduleRewrites: host.moduleRewrites,
				moduleRoot,
				outbound: prepared.outbound,
			});
			const child = await host.spawn();
			this.#child = child;
			if (this.#terminated) child.kill();
			const frames = readFrames(child.stdout, (line) => process.stdout.write(`${line}\n`));
			frames.on("message", (message: unknown) => {
				if (typeof message !== "object" || message === null) return;
				const stdout: unknown = Reflect.get(message, "openOrangeWorkerLoaderStdout");
				if (typeof stdout === "string") process.stdout.write(stdout);
				const abortReason: unknown = Reflect.get(message, "openOrangeWorkerLoaderAbort");
				if (typeof abortReason === "string") this.#abortReason = abortReason;
				const diagnostic: unknown = Reflect.get(message, "openOrangeWorkerLoaderDiagnostic");
				if (typeof diagnostic === "string") {
					this.#options.onDiagnostic(`Dynamic Worker ${this.#label}: ${diagnostic}`);
				}
			});
			const transport = new FramedRpcTransport(frames, (message) => {
				child.write(`${JSON.stringify(message)}\n`);
			});
			const main = openLoaderSession(transport);
			const removeHost = host;
			child.onExit((reason) => {
				this.#exited = true;
				transport.fail(this.#exitError(reason));
				this.#onExit();
				void removeHost.remove();
			});
			const reply = await main.start(envelope);
			if (reply !== undefined && reply !== null) decodeLoaderReply(reply);
			return { child, main };
		} catch (error: unknown) {
			this.terminate();
			if (this.#child === undefined && host !== undefined) await host.remove();
			throw error;
		}
	}

	// Like workerd, an isolate that abortIsolate() ended fails its calls with an internal error,
	// and the reason goes only to the log under the same reference.
	#exitError(reason: string): Error {
		if (this.#abortReason === undefined) {
			return new Error(`Dynamic Worker ${this.#label} exited unexpectedly (${reason}).`);
		}
		const reference = randomUUID();
		this.#options.onDiagnostic(
			`Dynamic Worker ${this.#label} called abortIsolate(${JSON.stringify(this.#abortReason)}); reference = ${reference}`,
		);
		return new Error(`internal error; reference = ${reference}`);
	}

	// A capability for `getEntrypoint(name, { props })`.
	entrypoint(name: string | undefined, props: unknown): Capability {
		const propsEnvelope = props === undefined ? undefined : encodeLoaderValue(props);
		const remote = this.#running.then(async ({ main }) => {
			const stub = await main.entrypoint(name, propsEnvelope);
			if ((typeof stub !== "object" || stub === null) && typeof stub !== "function") {
				throw new Error("Dynamic Worker returned an invalid entrypoint");
			}
			return new RemoteCapability(stub);
		});
		remote.catch(() => undefined);
		return new LazyCapability(remote);
	}

	terminate(): void {
		this.#terminated = true;
		if (this.#child !== undefined && !this.#exited) this.#child.kill();
	}
}

// Forwards calls to a capability once it exists. Each call fails with the
// startup error if the Worker cannot load.
class LazyCapability implements Capability {
	readonly #capability: Promise<Capability>;

	constructor(capability: Promise<Capability>) {
		this.#capability = capability;
	}

	call(path: readonly string[], args: readonly unknown[] | undefined): CallOutcome {
		const outcome = this.#capability.then((capability) => capability.call(path, args));
		const value = outcome.then((result) => result.value);
		const pipeline = outcome.then((result) => result.pipeline);
		value.catch(() => undefined);
		pipeline.catch(() => undefined);
		return { pipeline, value };
	}

	dup(): Capability {
		return this;
	}

	dispose(): void {}
}

function notSupported(message: string): Error {
	const error = new Error(message);
	error.name = "NotSupportedError";
	return error;
}

// A Fetcher for a dynamic Worker entrypoint: fetch() sends a Request and
// every other name is an RPC method.
function createEntrypointStub(capability: Capability): object {
	const root = createStub(capability);
	return new Proxy(root, {
		get(target, property, receiver): unknown {
			if (property === "fetch") {
				return (input: RequestInfo | URL, init?: RequestInit): Promise<unknown> => {
					try {
						const request = new Request(input, init);
						return Promise.resolve(capability.call(["fetch"], [request]).value);
					} catch (error: unknown) {
						return Promise.reject(error);
					}
				};
			}
			if (property === "connect") {
				return (): never => {
					throw notSupported(
						"OpenOrange does not support connect() on a dynamic Worker entrypoint. Use fetch() or RPC methods instead.",
					);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
}

export class WorkerStub {
	readonly #worker: DynamicWorker;

	constructor(worker: DynamicWorker) {
		this.#worker = worker;
	}

	getEntrypoint(name?: string | null, options?: { props?: unknown }): object {
		const entrypoint = name === undefined || name === null || name === "default" ? undefined : name;
		return createEntrypointStub(this.#worker.entrypoint(entrypoint, options?.props));
	}

	getDurableObjectClass(): never {
		throw notSupported(
			"OpenOrange does not support getDurableObjectClass() on dynamic Workers yet. Keep Durable Object state in the parent Worker and call the dynamic Worker through getEntrypoint().",
		);
	}
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-loader.c%2B%2B#L79-L135
export class WorkerLoader {
	// Workerd keeps one isolate per name in each loader binding, and an unnamed
	// get() or load() always starts a new one.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L5120-L5160
	readonly #named = new Map<string, DynamicWorker>();
	readonly #all = new Set<DynamicWorker>();
	readonly #options: WorkerLoaderOptions;

	constructor(options: WorkerLoaderOptions) {
		this.#options = options;
	}

	get(name: string | null | undefined, getCode: () => unknown): WorkerStub {
		if (typeof getCode !== "function") {
			throw new TypeError("WorkerLoader.get() requires a code callback.");
		}
		if (name !== null && name !== undefined) {
			const key = String(name);
			let worker = this.#named.get(key);
			if (worker === undefined) {
				worker = this.#create(key, async () => prepareCode(await getCode()), () => {
					if (this.#named.get(key) === worker) this.#named.delete(key);
				});
				this.#named.set(key, worker);
				// Orange forgets a Worker that failed to load, so the next get()
				// with this name calls its code callback again.
				const loaded = worker;
				loaded.ready.catch(() => {
					if (this.#named.get(key) === loaded) this.#named.delete(key);
				});
			}
			return new WorkerStub(worker);
		}
		return new WorkerStub(
			this.#create("(anonymous)", async () => prepareCode(await getCode()), () => undefined),
		);
	}

	// Like workerd, load() copies the code before it returns, so later changes
	// to the caller's buffers do not reach the Worker, and invalid code throws here.
	load(code: unknown): WorkerStub {
		const prepared = prepareCode(code);
		return new WorkerStub(this.#create("(anonymous)", async () => prepared, () => undefined));
	}

	#create(
		label: string,
		getCode: () => Promise<PreparedCode>,
		onExit: () => void,
	): DynamicWorker {
		const worker: DynamicWorker = new DynamicWorker(
			JSON.stringify(label),
			getCode,
			this.#options,
			() => {
				this.#all.delete(worker);
				onExit();
			},
		);
		this.#all.add(worker);
		return worker;
	}

	// Stops every dynamic Worker process. The runtime calls this on shutdown.
	close(): void {
		for (const worker of this.#all) worker.terminate();
	}
}

// The agentOS build of the child and its runtime modules. See
// `buildWorkerLoaderVmBundle`.
export function workerLoaderVmBundlePath(runnerUrl: string): string {
	for (const relative of ["./worker-loader-vm/", "../../../dist/runtime/worker-loader-vm/"]) {
		const candidate = new globalThis.URL(relative, runnerUrl);
		if (existsSync(new globalThis.URL("manifest.json", candidate))) return candidate.pathname;
	}
	throw new Error(
		"OpenOrange cannot find the agentOS Worker Loader bundle. Run `pnpm build`.",
	);
}
