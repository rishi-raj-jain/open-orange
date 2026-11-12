import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { runOnPlainNode } from "./plain-node.js";
import type { UpstreamTestFile } from "./sources.js";
import { createScratch, remapTmpPaths, removeScratch } from "./tmp-remap.js";

export const bindingKinds = [
	"service",
	"entrypoints",
	"vars",
	"unsafeEval",
	"loader",
	"kv",
	"r2",
	"queues",
	"analyticsEngine",
] as const;
export type BindingKind = (typeof bindingKinds)[number];

export interface UpstreamTestResult {
	status: "pass" | "fail" | "other-service";
	kind?: "boot" | "assert" | "crash" | "hang";
	error?: string;
	ms?: number;
	/** Outcome on plain Node.js with stock built-ins. Recorded for Node.js compat files only. */
	node?: "pass" | "fail";
	nodeError?: string;
}

export interface UpstreamFileResult {
	id: string;
	file: string;
	service: string | null;
	dropped: string[];
	boot: { ok: boolean; reason?: string; detail?: string } | null;
	tests: Record<string, UpstreamTestResult>;
	flags?: string[];
	restarts?: number;
}

export interface RunUpstreamFileOptions {
	file: UpstreamTestFile;
	capnpImportPath: string;
	repositoryRoot: string;
	workerdBinaryPath: string;
	compatibilityDate: string;
	bindings: ReadonlySet<BindingKind>;
	/** Environment for `orange dev`, including any `RIVET_ENGINE_BINARY` override. */
	env: NodeJS.ProcessEnv;
	port: number;
	logDirectory: string;
	timeoutMs: number;
	/** Whether the file writes to `/tmp`, so plain Node.js runs it with `/tmp` in a scratch directory. */
	writesTmp?: boolean;
	/** Export name to the reason the test does not run on Orange or plain Node.js. */
	notRunTests?: Readonly<Record<string, string>>;
}

const workerdTimeoutMs = 180_000;
const bootTimeoutMs = 120_000;
const testTimeoutMs = 60_000;
const maxRestarts = 25;
const plainNodeTimeoutMs = 300_000;

const liveStops = new Set<() => void>();

/** Kills every `orange dev` tree and Rivet Engine still owned by a running file. */
export function stopAllUpstreamProcesses(): void {
	for (const stop of liveStops) {
		stop();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CapturedRun {
	stdout: string;
	stderr: string;
	/** `exit=0` on success, otherwise the exit code, signal, or spawn error. */
	exit: string;
}

function runCaptured(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<CapturedRun> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout
			.setEncoding("utf8")
			.on("data", (chunk: string) => (stdout += chunk));
		child.stderr
			.setEncoding("utf8")
			.on("data", (chunk: string) => (stderr += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, exit: `error ${error.message}` });
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, exit: `exit=${code ?? signal}` });
		});
	});
}

/** Tests that pass on the pinned workerd, keyed `service` or `service:export`. */
async function workerdPassingTests(
	options: RunUpstreamFileOptions,
): Promise<string[]> {
	const testDirectory = await mkdtemp(join(tmpdir(), "oo-upstream-workerd-"));
	try {
		const run = await runCaptured(
			options.workerdBinaryPath,
			[
				"test",
				"--experimental",
				`--compat-date=${options.compatibilityDate}`,
				`-dTEST_TMPDIR=${testDirectory}`,
				basename(options.file.path),
			],
			dirname(options.file.path),
			workerdTimeoutMs,
		);
		const log = `${run.stdout}${run.stderr}`;
		await writeFile(
			join(options.logDirectory, `${options.file.id}.workerd.log`),
			`${log}${run.exit}\n`,
		);
		return [...log.matchAll(/\[ PASS \] (\S+)/g)].map(
			(match) => match[1] ?? "",
		);
	} finally {
		await rm(testDirectory, { recursive: true, force: true });
	}
}

interface WorkerdModule {
	name: string;
	esModule?: string;
	commonJsModule?: string;
	json?: string;
	text?: string;
	data?: string | number[];
	wasm?: string | number[];
}

interface WorkerdService {
	name: string;
	external?: { address?: string };
	worker?: {
		modules?: WorkerdModule[];
		bindings?: Array<Record<string, unknown> & { name: string }>;
		durableObjectNamespaces?: Array<{ className?: string }>;
		compatibilityFlags?: string[];
		tails?: Array<string | { name: string; entrypoint?: string }>;
	};
}

interface WorkerdConfig {
	services?: WorkerdService[];
	v8Flags?: string[];
	sockets?: Array<{
		address?: string;
		service?: { name: string; entrypoint?: string };
	}>;
}

async function evaluateConfig(
	options: RunUpstreamFileOptions,
): Promise<WorkerdConfig | { failure: string }> {
	const source = await readFile(options.file.path, "utf8");
	const constName =
		source.match(/const\s+(\w+)\s*:\s*Workerd\.Config/)?.[1] ?? "config";
	const run = await runCaptured(
		"capnp",
		[
			"eval",
			"-I",
			options.capnpImportPath,
			"-ojson",
			basename(options.file.path),
			constName,
		],
		dirname(options.file.path),
		workerdTimeoutMs,
	);
	if (run.exit !== "exit=0") {
		return { failure: run.stderr || run.exit };
	}
	return JSON.parse(run.stdout) as WorkerdConfig;
}

function moduleFileName(module: WorkerdModule): string {
	if (module.esModule !== undefined || module.commonJsModule !== undefined) {
		return /\.(m?js|cjs|ts)$/.test(module.name)
			? module.name
			: `${module.name}.js`;
	}
	if (module.json !== undefined) {
		return /\.json$/.test(module.name) ? module.name : `${module.name}.json`;
	}
	return `${module.name}.js`;
}

function bytes(value: string | number[]): number[] {
	return Array.isArray(value) ? value : [...Buffer.from(value, "base64")];
}

function moduleSource(module: WorkerdModule): string | undefined {
	if (module.esModule !== undefined) return module.esModule;
	if (module.commonJsModule !== undefined) return module.commonJsModule;
	if (module.json !== undefined) return module.json;
	if (module.text !== undefined)
		return `export default ${JSON.stringify(module.text)};`;
	if (module.data !== undefined)
		return `export default new Uint8Array(${JSON.stringify(bytes(module.data))}).buffer;`;
	// A wasm module imports as a compiled WebAssembly.Module, as in workerd.
	if (module.wasm !== undefined) {
		return `export default new WebAssembly.Module(new Uint8Array(${JSON.stringify(bytes(module.wasm))}));`;
	}
	return undefined;
}

// Each upstream export with a `test()` method runs through `/__run?t=<export>`, like `workerd test`.
function shimSource(mainFile: string, classDefault: boolean): string {
	return `
import * as M from "./${mainFile}";
export * from "./${mainFile}";
async function __run(request, env, ctx) {
	const name = new URL(request.url).searchParams.get("t");
	const target = M[name];
	if (!target || typeof target.test !== "function") return Response.json({ ok: false, error: "export has no test()" });
	try {
		await target.test({ scheduledTime: Date.now(), cron: "" }, env, ctx);
		return Response.json({ ok: true });
	} catch (e) {
		return Response.json({ ok: false, error: String((e && (e.stack || e.message)) || e).slice(0, 1500) });
	}
}
const D = M.default;
export default ${classDefault} && typeof D === "function" ? class extends D {
	async fetch(request) {
		if (new URL(request.url).pathname === "/__run") return __run(request, this.env, this.ctx);
		return super.fetch ? super.fetch(request) : new Response("not found", { status: 404 });
	}
} : Object.assign(Object.defineProperties({}, D !== null && typeof D === "object" ? Object.getOwnPropertyDescriptors(D) : {}), {
	async fetch(request, env, ctx) {
		if (new URL(request.url).pathname === "/__run") return __run(request, env, ctx);
		if (D && typeof D.fetch === "function") return D.fetch(request, env, ctx);
		return new Response("not found", { status: 404 });
	},
});
`;
}

/** Writes a service's modules under `<directory>/src`. Returns the main module's file name. */
async function writeModules(
	projectDirectory: string,
	modules: readonly WorkerdModule[],
	dropped: string[],
	transform: (source: string) => string = (source) => source,
): Promise<string> {
	for (const module of modules) {
		const fileName = moduleFileName(module);
		const original = moduleSource(module);
		const source = original === undefined ? undefined : transform(original);
		if (source === undefined) {
			dropped.push(
				`module ${module.name} (${Object.keys(module)
					.filter((key) => key !== "name")
					.join(",")})`,
			);
			continue;
		}
		const path = join(projectDirectory, "src", fileName);
		// Some upstream module names, such as `/foo/../../../../abc123`, would land outside the project.
		if (!path.startsWith(`${join(projectDirectory, "src")}${sep}`)) {
			dropped.push(`module ${module.name} (path outside the project)`);
			continue;
		}
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, source);
		// Bare module names also resolve through a node_modules alias.
		if (!module.name.startsWith(".") && module !== modules[0]) {
			const packageDirectory = join(
				projectDirectory,
				"node_modules",
				module.name,
			);
			if (
				!packageDirectory.startsWith(
					`${projectDirectory}${sep}node_modules${sep}`,
				)
			) {
				continue;
			}
			await mkdir(packageDirectory, { recursive: true });
			const up = "../".repeat(module.name.split("/").length + 1);
			await writeFile(
				join(packageDirectory, "package.json"),
				JSON.stringify({ name: module.name, main: `${up}src/${fileName}` }),
			);
		}
	}
	const mainModule = modules[0];
	if (mainModule === undefined) {
		throw new Error("The service has no modules");
	}
	return moduleFileName(mainModule);
}

/**
 * Writes the main service as an Orange project, and each other Worker that a service binding names
 * as a Worker of the same `orange dev` session. Returns the wrangler config paths, the main one first.
 */
async function writeProject(
	projectDirectory: string,
	config: WorkerdConfig,
	service: WorkerdService,
	options: RunUpstreamFileOptions,
	result: UpstreamFileResult,
): Promise<string[]> {
	const worker = service.worker ?? {};
	const mainFile = await writeModules(projectDirectory, worker.modules ?? [], result.dropped);
	await writeFile(
		join(projectDirectory, "src", "__shim.js"),
		shimSource(mainFile, options.bindings.has("entrypoints")),
	);

	const doClasses = (worker.durableObjectNamespaces ?? []).flatMap(
		(namespace) => (namespace.className ? [namespace.className] : []),
	);
	const workerName = options.file.id
		.replace(/[^a-z0-9-]/gi, "-")
		.toLowerCase()
		.slice(0, 60);
	// A binding to an external `loopback:` service resolves through its socket to this worker's entrypoint.
	const selfService = (designator: { name: string; entrypoint?: string }) => {
		if (!options.bindings.has("entrypoints")) return designator;
		const address = config.services?.find(
			(candidate) => candidate.name === designator.name,
		)?.external?.address;
		const socket = address?.startsWith("loopback:")
			? config.sockets?.find((candidate) => candidate.address === address)
			: undefined;
		return socket?.service ?? designator;
	};
	const doBindings: Array<{ name: string; class_name: string }> = [];
	const services: Array<{
		binding: string;
		service: string;
		entrypoint?: string;
	}> = [];
	const unsafeBindings: Array<{ name: string; type: string }> = [];
	const neighbours = new Map<string, WorkerdService>();
	const workerLoaders: Array<{ binding: string }> = [];
	const kvNamespaces: Array<{ binding: string; id: string }> = [];
	const r2Buckets: Array<{ binding: string; bucket_name: string }> = [];
	const queueProducers: Array<{ binding: string; queue: string }> = [];
	const analyticsDatasets: Array<{ binding: string; dataset: string }> = [];
	const vars: Record<string, unknown> = {};
	for (const binding of worker.bindings ?? []) {
		const kind = Object.keys(binding).find((key) => key !== "name");
		const namespace = binding.durableObjectNamespace as
			{ className?: string; serviceName?: string } | undefined;
		const target = isRecord(binding.service)
			? selfService(binding.service as { name: string; entrypoint?: string })
			: undefined;
		if (
			kind === "durableObjectNamespace" &&
			namespace?.className &&
			!namespace.serviceName &&
			doClasses.includes(namespace.className)
		) {
			doBindings.push({ name: binding.name, class_name: namespace.className });
		} else if (kind === "text" && options.bindings.has("vars")) {
			vars[binding.name] = binding.text;
		} else if (kind === "json" && options.bindings.has("vars")) {
			vars[binding.name] = JSON.parse(String(binding.json));
		} else if (kind === "kvNamespace" && options.bindings.has("kv")) {
			kvNamespaces.push({ binding: binding.name, id: binding.name.toLowerCase() });
		} else if (kind === "r2Bucket" && options.bindings.has("r2")) {
			r2Buckets.push({ binding: binding.name, bucket_name: binding.name.toLowerCase() });
		} else if (kind === "queue" && options.bindings.has("queues")) {
			queueProducers.push({ binding: binding.name, queue: binding.name.toLowerCase() });
		} else if (kind === "analyticsEngine" && options.bindings.has("analyticsEngine")) {
			analyticsDatasets.push({ binding: binding.name, dataset: binding.name.toLowerCase() });
		} else if (kind === "workerLoader" && options.bindings.has("loader")) {
			workerLoaders.push({ binding: binding.name });
		} else if (kind === "unsafeEval" && options.bindings.has("unsafeEval")) {
			unsafeBindings.push({ name: binding.name, type: "unsafe_eval" });
		} else if (
			kind === "service" &&
			options.bindings.has("service") &&
			target?.name === service.name
		) {
			services.push({
				binding: binding.name,
				service: workerName,
				...(target.entrypoint ? { entrypoint: target.entrypoint } : {}),
			});
		} else if (
			kind === "service" &&
			options.bindings.has("service") &&
			target !== undefined &&
			config.services?.find((candidate) => candidate.name === target.name)?.worker?.modules?.length
		) {
			neighbours.set(
				target.name,
				config.services.find((candidate) => candidate.name === target.name)!,
			);
			services.push({
				binding: binding.name,
				service: neighbourWorkerName(workerName, target.name),
				...(target.entrypoint ? { entrypoint: target.entrypoint } : {}),
			});
		} else {
			result.dropped.push(`binding ${binding.name} (${kind})`);
		}
	}
	// A worker that tails itself gets its own tail_consumers entry. Other tail targets are dropped.
	const tailConsumers: Array<{ service: string }> = [];
	for (const tail of worker.tails ?? []) {
		const target = typeof tail === "string" ? { name: tail } : tail;
		if (options.bindings.has("service") && target.name === service.name && target.entrypoint === undefined) {
			tailConsumers.push({ service: workerName });
		} else {
			result.dropped.push(`tail ${target.name}`);
		}
	}
	const wrangler = {
		name: workerName,
		...(services.length > 0 ? { services } : {}),
		...(tailConsumers.length > 0 ? { tail_consumers: tailConsumers } : {}),
		...(unsafeBindings.length > 0
			? { unsafe: { bindings: unsafeBindings } }
			: {}),
		...(workerLoaders.length > 0 ? { worker_loaders: workerLoaders } : {}),
		...(kvNamespaces.length > 0 ? { kv_namespaces: kvNamespaces } : {}),
		...(r2Buckets.length > 0 ? { r2_buckets: r2Buckets } : {}),
		...(queueProducers.length > 0 ? { queues: { producers: queueProducers } } : {}),
		...(analyticsDatasets.length > 0 ? { analytics_engine_datasets: analyticsDatasets } : {}),
		...(Object.keys(vars).length > 0 ? { vars } : {}),
		main: "src/__shim.js",
		compatibility_date: options.compatibilityDate,
		compatibility_flags: flagsOrangeApplies(service),
		...(doClasses.length > 0
			? {
					durable_objects: { bindings: doBindings },
					migrations: [{ tag: "v1", new_sqlite_classes: doClasses }],
				}
			: {}),
	};
	const wranglerPath = join(projectDirectory, "wrangler.jsonc");
	await writeFile(wranglerPath, JSON.stringify(wrangler, null, 1));
	const configs = [wranglerPath];
	for (const [name, neighbour] of neighbours) {
		const directory = join(projectDirectory, "workers", name.replace(/[^a-z0-9-]/gi, "-"));
		const neighbourWorker = neighbour.worker ?? {};
		const main = await writeModules(directory, neighbourWorker.modules ?? [], result.dropped);
		const path = join(directory, "wrangler.jsonc");
		await writeFile(
			path,
			JSON.stringify(
				{
					name: neighbourWorkerName(workerName, name),
					main: `src/${main}`,
					compatibility_date: options.compatibilityDate,
					compatibility_flags: flagsOrangeApplies(neighbour),
				},
				null,
				1,
			),
		);
		for (const binding of neighbourWorker.bindings ?? []) {
			result.dropped.push(`binding ${binding.name} of ${name}`);
		}
		configs.push(path);
	}
	return configs;
}

// Orange warns on a flag it ignores, so only a flag it applies goes through.
function flagsOrangeApplies(service: WorkerdService): string[] {
	return (service.worker?.compatibilityFlags ?? []).filter((flag) => flag === "request_signal_passthrough");
}

function neighbourWorkerName(workerName: string, service: string): string {
	return `${workerName}-${service}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 63);
}

/**
 * Kills the `orange dev` process group. The Rivet Engine it started is detached from that group and
 * keeps running.
 */
function killOrangeProcessGroup(child: ChildProcess): void {
	if (child.pid !== undefined) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {}
	}
}

/**
 * Kills the `orange dev` process group, then the Rivet Engine it started. The engine PID comes from
 * the runtime stamp RivetKit writes under the project.
 */
function killOrangeTree(child: ChildProcess, projectDirectory: string): void {
	killOrangeProcessGroup(child);
	const storageRoot = join(projectDirectory, ".open-orange", "rivetkit");
	let identities: string[] = [];
	try {
		identities = readdirSync(storageRoot);
	} catch {}
	for (const identity of identities) {
		const stampPath = join(
			storageRoot,
			identity,
			".rivetkit",
			"var",
			"engine",
			"runtime.json",
		);
		try {
			const stamp: unknown = JSON.parse(readFileSync(stampPath, "utf8"));
			// Remove the stamp so a restart never kills a reused PID from an earlier engine.
			rmSync(stampPath, { force: true });
			if (
				isRecord(stamp) &&
				typeof stamp.pid === "number" &&
				Number.isInteger(stamp.pid) &&
				stamp.pid > 0
			) {
				process.kill(stamp.pid, "SIGKILL");
			}
		} catch {}
	}
}

function bootDetail(log: string): string {
	const buildFailed = log.indexOf("Build failed");
	if (buildFailed !== -1) {
		return log.slice(buildFailed, buildFailed + 800);
	}
	const errors = log
		.split("\n")
		.filter((line) =>
			/error|Error|Unsupported|not implemented|must /.test(line),
		)
		.slice(0, 6)
		.join("\n")
		.slice(0, 1500);
	return errors || log.slice(-1500);
}

/** Text and JSON bindings, the only ones a plain Node.js process can get without workerd. */
function plainEnv(service: WorkerdService): Record<string, unknown> {
	const env: Record<string, unknown> = {};
	for (const binding of service.worker?.bindings ?? []) {
		if (typeof binding.text === "string") env[binding.name] = binding.text;
		if (typeof binding.json === "string") {
			env[binding.name] = JSON.parse(binding.json);
		}
	}
	return env;
}

/** Runs the file's tests on plain Node.js. Keys are export names. */
async function plainNodeOutcomes(
	options: RunUpstreamFileOptions,
	config: WorkerdConfig,
	service: WorkerdService,
	tests: readonly string[],
): ReturnType<typeof runOnPlainNode> {
	const directory = await mkdtemp(
		join(tmpdir(), `oo-upstream-node-${options.file.id.slice(0, 40)}-`),
	);
	// On plain Node.js /tmp is the host /tmp, so the file's /tmp paths name a scratch directory.
	const scratch = options.writesTmp === true ? await createScratch() : undefined;
	try {
		await writeFile(join(directory, "package.json"), '{"type":"module"}');
		const main = await writeModules(
			directory,
			service.worker?.modules ?? [],
			[],
			scratch === undefined
				? undefined
				: (source) => remapTmpPaths(source, scratch.tmp),
		);
		return await runOnPlainNode({
			directory,
			main: join("src", main),
			tests,
			env: plainEnv(service),
			nodeFlags: config.v8Flags ?? [],
			logPath: join(options.logDirectory, `${options.file.id}.node.log`),
			timeoutMs: plainNodeTimeoutMs,
			...(scratch === undefined ? {} : { resetDirectory: scratch.tmp }),
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
		if (scratch !== undefined) await removeScratch(scratch);
	}
}

export async function runUpstreamFile(
	options: RunUpstreamFileOptions,
): Promise<UpstreamFileResult> {
	const result: UpstreamFileResult = {
		id: options.file.id,
		file: options.file.relativePath,
		service: null,
		dropped: [],
		boot: null,
		tests: {},
	};
	const deadline = Date.now() + options.timeoutMs;
	const passed = await workerdPassingTests(options);

	const config = await evaluateConfig(options);
	if ("failure" in config) {
		result.boot = {
			ok: false,
			reason: "capnp-eval",
			detail: config.failure.slice(0, 400),
		};
		return result;
	}
	const candidates = (config.services ?? []).filter(
		(service) => (service.worker?.modules?.length ?? 0) > 0,
	);
	const service =
		candidates.find((candidate) => candidate.name === "main") ?? candidates[0];
	result.service = service?.name ?? null;
	const belongs = (test: string) =>
		service !== undefined &&
		(test === service.name || test.startsWith(`${service.name}:`));
	for (const test of passed) {
		if (!belongs(test)) {
			result.tests[test] = { status: "other-service" };
		}
	}
	const mine = passed.filter(belongs);
	if (service === undefined || mine.length === 0) {
		result.boot = { ok: false, reason: "no-portable-tests" };
		return result;
	}
	const exportName = (test: string) =>
		test === service.name ? "default" : test.slice(service.name.length + 1);
	// Export names such as `toString` must not read inherited properties.
	const notRunReason = (test: string) =>
		options.notRunTests !== undefined && Object.hasOwn(options.notRunTests, exportName(test))
			? options.notRunTests[exportName(test)]
			: undefined;
	const projectDirectory = await mkdtemp(
		join(tmpdir(), `oo-upstream-${options.file.id.slice(0, 40)}-`),
	);
	const logFile = createWriteStream(
		join(options.logDirectory, `${options.file.id}.orange.log`),
	);
	let child: ChildProcess | undefined;
	let log = "";
	let wranglerPaths: string[] = [];
	const stop = () => {
		if (child !== undefined) killOrangeTree(child, projectDirectory);
	};
	liveStops.add(stop);

	const killAndWait = async (kill: (current: ChildProcess) => void) => {
		const current = child;
		if (current?.pid === undefined) return;
		const exited =
			current.exitCode !== null || current.signalCode !== null
				? Promise.resolve()
				: new Promise<void>((resolve) => current.once("exit", () => resolve()));
		kill(current);
		await exited;
	};
	const stopAndWait = () =>
		killAndWait((current) => killOrangeTree(current, projectDirectory));

	// workerd applies `v8Flags` such as `--expose-gc` to the isolate. Orange runs
	// Workers in a Node.js child of `orange dev`, which inherits NODE_OPTIONS.
	const nodeOptions = [options.env.NODE_OPTIONS, ...(config.v8Flags ?? [])]
		.filter((option) => option !== undefined && option !== "")
		.join(" ");
	const boot = (): Promise<string> => {
		log = "";
		const started = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				join(options.repositoryRoot, "src", "bin.ts"),
				"dev",
				...wranglerPaths.flatMap((path) => ["--config", path]),
				"--port",
				String(options.port),
				"--ip",
				"127.0.0.1",
				"--show-interactive-dev-session=false",
			],
			{
				cwd: options.repositoryRoot,
				detached: true,
				env: {
					...options.env,
					CI: "1",
					NO_COLOR: "1",
					...(nodeOptions === "" ? {} : { NODE_OPTIONS: nodeOptions }),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		child = started;
		const onData = (chunk: Buffer) => {
			log += chunk.toString("utf8");
			logFile.write(chunk);
		};
		started.stdout?.on("data", onData);
		started.stderr?.on("data", onData);
		return new Promise((resolve) => {
			const timer = setTimeout(
				() => resolve("timeout"),
				Math.max(0, Math.min(bootTimeoutMs, deadline - Date.now())),
			);
			const check = () => {
				if (/^\s+Local\s+http/m.test(log)) {
					clearTimeout(timer);
					resolve("ok");
				}
			};
			started.stdout?.on("data", check);
			started.stderr?.on("data", check);
			started.once("error", (error) => {
				clearTimeout(timer);
				resolve(`error ${error.message}`);
			});
			started.once("exit", (code) => {
				clearTimeout(timer);
				resolve(`exit ${code}`);
			});
		});
	};

	try {
		wranglerPaths = await writeProject(projectDirectory, config, service, options, result);
		result.flags = service.worker?.compatibilityFlags ?? [];

		const ready = await boot();
		if (ready !== "ok") {
			result.boot = { ok: false, reason: ready, detail: bootDetail(log) };
			for (const test of mine) {
				result.tests[test] = {
					status: "fail",
					kind: "boot",
					error: result.boot.detail?.slice(0, 400) ?? "",
				};
			}
			return result;
		}
		result.boot = { ok: true };
		result.restarts = 0;

		for (const test of mine) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				break;
			}
			const name = exportName(test);
			const notRun = notRunReason(test);
			if (notRun !== undefined) {
				result.tests[test] = {
					status: "fail",
					kind: "boot",
					error: `Not run: ${notRun}`,
				};
				continue;
			}
			const started = Date.now();
			try {
				const response = await fetch(
					`http://127.0.0.1:${options.port}/__run?t=${encodeURIComponent(name)}`,
					{
						signal: AbortSignal.timeout(Math.min(testTimeoutMs, remaining)),
					},
				);
				const text = await response.text();
				let body: { ok?: boolean; error?: string };
				try {
					body = JSON.parse(text) as { ok?: boolean; error?: string };
				} catch {
					body = {
						ok: false,
						error: `HTTP ${response.status}: ${text.slice(0, 400)}`,
					};
				}
				result.tests[test] = body.ok
					? { status: "pass", ms: Date.now() - started }
					: { status: "fail", kind: "assert", error: body.error ?? "" };
			} catch (error: unknown) {
				// Give a dying process a moment to exit so a crash is told apart from a hang.
				await delay(500);
				const died = child?.exitCode !== null || child?.signalCode !== null;
				const crashLines = log
					.split("\n")
					.filter((line) => /Error|error|Uncaught|unhandled/.test(line))
					.slice(-3)
					.join(" | ")
					.slice(0, 600);
				result.tests[test] = died
					? {
							status: "fail",
							kind: "crash",
							error: `orange process exited while running this test: ${crashLines}`,
						}
					: {
							status: "fail",
							kind: "hang",
							error:
								error instanceof Error
									? `${error.name}: ${error.message}`
									: String(error),
						};
				// Restart so later tests in the file still get a real result. The engine keeps running
				// and the new `orange dev` reattaches to it. The engine expires the killed envoy when
				// its connection closes. A killed engine cannot do that, so a restarted engine would
				// still route actors to the dead envoy until the envoy lost threshold passes.
				await killAndWait(killOrangeProcessGroup);
				if (Date.now() >= deadline) {
					break;
				}
				if (result.restarts++ >= maxRestarts || (await boot()) !== "ok") {
					for (const remainingTest of mine) {
						result.tests[remainingTest] ??= {
							status: "fail",
							kind: "crash",
							error: "orange could not be restarted",
						};
					}
					break;
				}
			}
		}
		for (const test of mine) {
			result.tests[test] ??= {
				status: "fail",
				kind: "hang",
				error: `file exceeded the ${Math.round(options.timeoutMs / 1000)}s timeout`,
			};
		}
		return result;
	} finally {
		await stopAndWait();
		liveStops.delete(stop);
		await new Promise<void>((resolve) => logFile.end(resolve));
		await rm(projectDirectory, { recursive: true, force: true });
		// Node.js compat tests also run on plain Node.js, so the score can leave out the ones that
		// test workerd-specific behavior.
		const nodeOutcomes = options.file.id.startsWith("node-tests--")
			? await plainNodeOutcomes(
					options,
					config,
					service,
					mine.filter((test) => notRunReason(test) === undefined).map(exportName),
				)
			: {};
		for (const test of mine) {
			const outcome = nodeOutcomes[exportName(test)];
			const tested = result.tests[test];
			// A test that plain Node.js cannot load stays scored.
			if (
				outcome === undefined ||
				outcome.status === "not-run" ||
				tested === undefined
			) {
				continue;
			}
			tested.node = outcome.status;
			if (outcome.error !== undefined) {
				tested.nodeError = outcome.error.slice(0, 1500);
			}
		}
	}
}
