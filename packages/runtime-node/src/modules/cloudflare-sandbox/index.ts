// The `@cloudflare/sandbox` module. Orange resolves the npm package to this
// file, so a Worker that exports `Sandbox` and calls `getSandbox()` runs
// unchanged. Each Sandbox Durable Object owns one provider sandbox: its id is
// stored in the object's storage, reconnected on wake, and deleted by
// `destroy()`. The provider comes from ORANGE_SANDBOX_PROVIDER (see
// providers.ts). API shapes follow the Sandbox SDK reference:
// https://developers.cloudflare.com/sandbox/api/
import { runtimeSettings } from "../../internal/runtime-settings.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { connect as netConnect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { DurableObject } from "../cloudflare-workers/index.js";
import {
	type ExecOptions,
	type SandboxBackend,
	SandboxConfigurationError,
	type SandboxProvider,
	previewUnreachableHeader,
	sandboxProviderFromEnvironment,
	sandboxProviderNamed,
	shellQuote,
} from "./providers.js";

const sandboxRecordKey = "__orange_sandbox";
const portTokensKey = "__orange_port_tokens";

/** The preview URL token and name of each exposed port, keyed by port number. */
type PortTokens = Record<string, { token: string; name?: string }>;

interface SandboxRecord {
	id: string;
	provider: string;
}

export interface ExecResult {
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	command: string;
	duration: number;
	timestamp: string;
}

export interface SandboxExecOptions {
	timeout?: number;
	env?: Record<string, string>;
	cwd?: string;
}

export interface ProcessInfo {
	id: string;
	pid?: number;
	command: string;
	status: "running" | "completed" | "failed" | "killed";
	startTime: string;
	endTime?: string;
	exitCode?: number;
}

interface LogEvent {
	type: "stdout" | "stderr";
	data: string;
	timestamp: string;
}

interface ProcessRecord {
	info: ProcessInfo;
	logs: LogEvent[];
	listeners: Set<() => void>;
	abort: AbortController;
}

// Background processes live as long as the Orange runtime process, keyed by
// provider sandbox id, so a Durable Object that is re-created still sees them.
const processesBySandbox = new Map<string, Map<string, ProcessRecord>>();

const encoder = new TextEncoder();

function sseEvent(value: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

/** Parses a Sandbox SSE stream, as `parseSSEStream` in `@cloudflare/sandbox` does. */
export async function* parseSSEStream<T = unknown>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		let boundary = buffer.indexOf("\n\n");
		while (boundary !== -1) {
			const event = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			for (const line of event.split("\n")) {
				// SAFETY: As in `@cloudflare/sandbox`, the caller names the event type of the stream and the parsed JSON is not validated against it.
				if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as T;
			}
			boundary = buffer.indexOf("\n\n");
		}
	}
}

function unsupported(method: string, alternative: string): never {
	throw new Error(`Sandbox.${method}() is not supported by Orange yet. ${alternative}`);
}

export class Sandbox<Env = unknown> extends DurableObject<Env> {
	#provider: SandboxProvider | undefined;
	#backend: Promise<{ id: string; backend: SandboxBackend }> | undefined;
	#env: Record<string, string> = {};

	#providerOrThrow(): SandboxProvider {
		this.#provider ??= sandboxProviderFromEnvironment(runtimeSettings());
		return this.#provider;
	}

	#owner(): string {
		return String(this.ctx.id);
	}

	#connect(): Promise<{ id: string; backend: SandboxBackend }> {
		this.#backend ??= this.#connectOnce().catch((error: unknown) => {
			this.#backend = undefined;
			throw error;
		});
		return this.#backend;
	}

	async #connectOnce(): Promise<{ id: string; backend: SandboxBackend }> {
		const provider = this.#providerOrThrow();
		const storage = this.ctx.storage;
		const owner = this.#owner();
		const record = await storage.get<SandboxRecord>(sandboxRecordKey);
		if (record !== undefined) {
			if (record.provider !== provider.name) {
				throw new SandboxConfigurationError(
					`This sandbox was created with the ${record.provider} provider, but ORANGE_SANDBOX_PROVIDER is now ${provider.name}. Switch back, or call destroy() to start over.`,
				);
			}
			const backend = await provider.connect(owner, record.id);
			if (backend !== undefined) return { backend, id: record.id };
		}
		const id = await provider.create(owner);
		await storage.put(sandboxRecordKey, { id, provider: provider.name } satisfies SandboxRecord);
		const backend = await provider.connect(owner, id);
		if (backend === undefined) {
			throw new Error(`The ${provider.name} sandbox provider created sandbox ${id} but cannot connect to it`);
		}
		return { backend, id };
	}

	#execOptions(backend: SandboxBackend, options: SandboxExecOptions = {}): ExecOptions {
		return {
			cwd: options.cwd ?? backend.cwd,
			env: { ...this.#env, ...options.env },
			timeoutMs: options.timeout,
		};
	}

	async exec(command: string, options?: SandboxExecOptions): Promise<ExecResult> {
		const { backend } = await this.#connect();
		const started = Date.now();
		const output = await backend.exec(command, this.#execOptions(backend, options));
		return {
			command,
			duration: Date.now() - started,
			exitCode: output.exitCode,
			stderr: output.stderr,
			stdout: output.stdout,
			success: output.exitCode === 0,
			timestamp: new Date(started).toISOString(),
		};
	}

	async execStream(command: string, options?: SandboxExecOptions): Promise<ReadableStream<Uint8Array>> {
		const { backend } = await this.#connect();
		const execOptions = this.#execOptions(backend, options);
		const abort = new AbortController();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				const now = () => new Date().toISOString();
				controller.enqueue(sseEvent({ command, timestamp: now(), type: "start" }));
				backend
					.exec(command, {
						...execOptions,
						onStderr: (data) => controller.enqueue(sseEvent({ data, timestamp: now(), type: "stderr" })),
						onStdout: (data) => controller.enqueue(sseEvent({ data, timestamp: now(), type: "stdout" })),
						signal: abort.signal,
					})
					.then(
						(result) =>
							controller.enqueue(
								sseEvent({ exitCode: result.exitCode, result: { ...result, command }, timestamp: now(), type: "complete" }),
							),
						(error: unknown) =>
							controller.enqueue(sseEvent({ error: String(error), timestamp: now(), type: "error" })),
					)
					.finally(() => controller.close());
			},
			cancel() {
				abort.abort();
			},
		});
	}

	async startProcess(command: string, options: SandboxExecOptions & { processId?: string } = {}): Promise<ProcessInfo> {
		const { backend, id } = await this.#connect();
		const processes = processesBySandbox.get(id) ?? new Map<string, ProcessRecord>();
		processesBySandbox.set(id, processes);
		const processId = options.processId ?? crypto.randomUUID();
		if (processes.get(processId)?.info.status === "running") {
			throw new Error(`Process ${processId} is already running`);
		}
		const record: ProcessRecord = {
			abort: new AbortController(),
			info: { command, id: processId, startTime: new Date().toISOString(), status: "running" },
			listeners: new Set(),
			logs: [],
		};
		processes.set(processId, record);
		const push = (type: LogEvent["type"]) => (data: string) => {
			record.logs.push({ data, timestamp: new Date().toISOString(), type });
			for (const listener of record.listeners) listener();
		};
		const finish = (status: ProcessInfo["status"], exitCode?: number) => {
			record.info = { ...record.info, endTime: new Date().toISOString(), exitCode, status };
			for (const listener of record.listeners) listener();
		};
		backend
			.exec(command, {
				...this.#execOptions(backend, options),
				onStderr: push("stderr"),
				onStdout: push("stdout"),
				signal: record.abort.signal,
			})
			.then(
				(result) =>
					finish(record.abort.signal.aborted ? "killed" : result.exitCode === 0 ? "completed" : "failed", result.exitCode),
				(error: unknown) => {
					push("stderr")(String(error));
					finish("failed");
				},
			);
		return record.info;
	}

	async #process(processId: string): Promise<ProcessRecord> {
		const { id } = await this.#connect();
		const record = processesBySandbox.get(id)?.get(processId);
		if (record === undefined) throw new Error(`Process not found: ${processId}`);
		return record;
	}

	async listProcesses(): Promise<ProcessInfo[]> {
		const { id } = await this.#connect();
		return [...(processesBySandbox.get(id)?.values() ?? [])].map((record) => record.info);
	}

	async getProcess(processId: string): Promise<ProcessInfo | null> {
		const { id } = await this.#connect();
		return processesBySandbox.get(id)?.get(processId)?.info ?? null;
	}

	// Resolves after the process has exited, as on Cloudflare, so a status read
	// right after kill() reports `killed`.
	async killProcess(processId: string, _signal?: string): Promise<void> {
		const record = await this.#process(processId);
		record.abort.abort();
		await this.waitForProcessExit(processId);
	}

	// Resolves when `check` returns a value, re-checking after each log line or
	// exit. Rejects after `timeout` milliseconds, or when the process exits first.
	#waitFor<T>(record: ProcessRecord, what: string, timeout: number | undefined, check: () => T | undefined): Promise<T> {
		return new Promise<T>((resolveWait, rejectWait) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const listener = () => {
				const value = check();
				if (value !== undefined) {
					done();
					resolveWait(value);
				} else if (record.info.status !== "running") {
					done();
					rejectWait(new Error(`Process ${record.info.id} exited with code ${record.info.exitCode} before ${what}`));
				}
			};
			const done = () => {
				clearTimeout(timer);
				record.listeners.delete(listener);
			};
			if (timeout !== undefined) {
				timer = setTimeout(() => {
					done();
					rejectWait(new Error(`Timed out after ${timeout}ms waiting for ${what} from process ${record.info.id}`));
				}, timeout);
			}
			record.listeners.add(listener);
			listener();
		});
	}

	/** Backs `Process.waitForLog()`. The pattern is a string or a RegExp source and flags. */
	async waitForProcessLog(
		processId: string,
		pattern: string | { source: string; flags: string },
		timeout?: number,
	): Promise<{ line: string }> {
		const record = await this.#process(processId);
		const regex = typeof pattern === "string" ? undefined : new RegExp(pattern.source, pattern.flags.replace("g", ""));
		const matches = (line: string) =>
			typeof pattern === "string" ? line.includes(pattern) : regex !== undefined && regex.test(line);
		return this.#waitFor(record, `log pattern ${String(regex ?? pattern)}`, timeout, () => {
			for (const type of ["stdout", "stderr"] as const) {
				const text = record.logs
					.filter((event) => event.type === type)
					.map((event) => event.data)
					.join("");
				const line = text.split("\n").find(matches);
				if (line !== undefined) return { line };
			}
			return undefined;
		});
	}

	/** Backs `Process.waitForExit()`. */
	async waitForProcessExit(processId: string, timeout?: number): Promise<{ exitCode: number }> {
		const record = await this.#process(processId);
		if (record.info.status !== "running") return { exitCode: record.info.exitCode ?? -1 };
		return new Promise((resolveWait, rejectWait) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const listener = () => {
				if (record.info.status === "running") return;
				clearTimeout(timer);
				record.listeners.delete(listener);
				resolveWait({ exitCode: record.info.exitCode ?? -1 });
			};
			if (timeout !== undefined) {
				timer = setTimeout(() => {
					record.listeners.delete(listener);
					rejectWait(new Error(`Timed out after ${timeout}ms waiting for process ${processId} to exit`));
				}, timeout);
			}
			record.listeners.add(listener);
		});
	}

	/**
	 * Backs `Process.waitForPort()`. Checks the port every `interval` ms (default
	 * 500), as the Sandbox SDK does, until it answers or the process exits.
	 */
	async waitForProcessPort(
		processId: string,
		port: number,
		options: { mode?: "http" | "tcp"; path?: string; status?: number | { min: number; max: number }; timeout?: number; interval?: number } = {},
	): Promise<void> {
		const record = await this.#process(processId);
		const { backend } = await this.#connect();
		const status = options.status ?? { min: 200, max: 399 };
		const [min, max] = typeof status === "number" ? [status, status] : [status.min, status.max];
		const path = options.path ?? "/";
		const ready = async (): Promise<boolean> => {
			if (backend.previewOrigin !== undefined) {
				const origin = backend.previewOrigin(port);
				if (options.mode === "tcp") {
					const { hostname } = new URL(origin);
					return new Promise((resolveCheck) => {
						const socket = netConnect({ host: hostname, port }, () => {
							socket.destroy();
							resolveCheck(true);
						});
						socket.once("error", () => resolveCheck(false));
					});
				}
				try {
					const response = await fetch(new URL(path, origin));
					await response.body?.cancel();
					return response.status >= min && response.status <= max;
				} catch {
					return false;
				}
			}
			// agentOS VMs have no curl, and their servers answer only through the preview path.
			if (backend.previewFetch !== undefined) {
				try {
					const response = await backend.previewFetch(port, new Request(new URL(path, "http://127.0.0.1")));
					await response.body?.cancel();
					if (response.headers.has(previewUnreachableHeader)) return false;
					return options.mode === "tcp" || (response.status >= min && response.status <= max);
				} catch {
					return false;
				}
			}
			const command =
				options.mode === "tcp"
					? `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null`
					: `code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}${path}) && [ "$code" -ge ${min} ] && [ "$code" -le ${max} ]`;
			const result = await backend.exec(`bash -c ${shellQuote(command)}`, { cwd: backend.cwd });
			return result.exitCode === 0;
		};
		const deadline = options.timeout === undefined ? undefined : Date.now() + options.timeout;
		for (;;) {
			if (await ready()) return;
			if (record.info.status !== "running") {
				throw new Error(`Process ${processId} exited with code ${record.info.exitCode} before port ${port} was ready`);
			}
			if (deadline !== undefined && Date.now() >= deadline) {
				throw new Error(`Timed out after ${options.timeout}ms waiting for port ${port} from process ${processId}`);
			}
			await sleep(options.interval ?? 500);
		}
	}

	async killAllProcesses(): Promise<number> {
		const { id } = await this.#connect();
		const running = [...(processesBySandbox.get(id)?.values() ?? [])].filter((record) => record.info.status === "running");
		for (const record of running) record.abort.abort();
		await Promise.all(running.map((record) => this.waitForProcessExit(record.info.id)));
		return running.length;
	}

	async getProcessLogs(processId: string): Promise<{ processId: string; stdout: string; stderr: string }> {
		const record = await this.#process(processId);
		const join = (type: LogEvent["type"]) =>
			record.logs
				.filter((event) => event.type === type)
				.map((event) => event.data)
				.join("");
		return { processId, stderr: join("stderr"), stdout: join("stdout") };
	}

	async streamProcessLogs(processId: string): Promise<ReadableStream<Uint8Array>> {
		const record = await this.#process(processId);
		let sent = 0;
		let listener: (() => void) | undefined;
		return new ReadableStream<Uint8Array>({
			start(controller) {
				const onLog = () => {
					while (sent < record.logs.length) {
						const event = record.logs[sent];
						sent += 1;
						if (event !== undefined) controller.enqueue(sseEvent({ ...event, processId }));
					}
					if (record.info.status !== "running") {
						record.listeners.delete(onLog);
						controller.enqueue(
							sseEvent({ exitCode: record.info.exitCode, processId, timestamp: new Date().toISOString(), type: "exit" }),
						);
						controller.close();
					}
				};
				listener = onLog;
				record.listeners.add(onLog);
				onLog();
			},
			cancel() {
				if (listener !== undefined) record.listeners.delete(listener);
			},
		});
	}

	async writeFile(path: string, content: string, options: { encoding?: string } = {}) {
		const { backend } = await this.#connect();
		const bytes = options.encoding === "base64" ? Buffer.from(content, "base64") : encoder.encode(content);
		await backend.writeFile(path, bytes);
		return { path, success: true, timestamp: new Date().toISOString() };
	}

	async readFile(path: string, options: { encoding?: string } = {}) {
		const { backend } = await this.#connect();
		const bytes = await backend.readFile(path);
		const encoding = options.encoding === "base64" ? "base64" : "utf-8";
		const content = encoding === "base64" ? Buffer.from(bytes).toString("base64") : new TextDecoder().decode(bytes);
		return { content, encoding, path, success: true, timestamp: new Date().toISOString() };
	}

	async mkdir(path: string, options: { recursive?: boolean } = {}) {
		const { backend } = await this.#connect();
		await backend.mkdir(path, options.recursive ?? false);
		return { path, recursive: options.recursive ?? false, success: true, timestamp: new Date().toISOString() };
	}

	async deleteFile(path: string) {
		const { backend } = await this.#connect();
		await backend.deleteFile(path);
		return { path, success: true, timestamp: new Date().toISOString() };
	}

	async renameFile(oldPath: string, newPath: string) {
		const { backend } = await this.#connect();
		await backend.rename(oldPath, newPath);
		return { newPath, path: oldPath, success: true, timestamp: new Date().toISOString() };
	}

	async moveFile(sourcePath: string, destinationPath: string) {
		const { backend } = await this.#connect();
		await backend.rename(sourcePath, destinationPath);
		return { newPath: destinationPath, path: sourcePath, success: true, timestamp: new Date().toISOString() };
	}

	async exists(path: string) {
		const { backend } = await this.#connect();
		return { exists: await backend.exists(path), success: true, timestamp: new Date().toISOString() };
	}

	async listFiles(path: string, options: { recursive?: boolean; includeHidden?: boolean } = {}) {
		const { backend } = await this.#connect();
		const entries = await backend.list(path, options.recursive ?? false);
		const files = entries
			.filter((entry) => options.includeHidden === true || !entry.name.split("/").some((part) => part.startsWith(".")))
			.map((entry) => ({
				absolutePath: `${path.replace(/\/$/, "")}/${entry.name}`,
				modifiedAt: entry.modifiedAt,
				name: entry.name.split("/").at(-1) ?? entry.name,
				relativePath: entry.name,
				size: entry.size,
				type: entry.isDirectory ? "directory" : "file",
			}));
		return { count: files.length, files, path, success: true, timestamp: new Date().toISOString() };
	}

	async gitCheckout(repoUrl: string, options: { branch?: string; targetDir?: string } = {}) {
		const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
		const targetDir = options.targetDir ?? `/workspace/${repoUrl.split("/").at(-1)?.replace(/\.git$/, "") ?? "repo"}`;
		const branch = options.branch === undefined ? "" : `--branch ${quote(options.branch)} `;
		const result = await this.exec(`git clone --depth 1 ${branch}${quote(repoUrl)} ${quote(targetDir)}`);
		if (!result.success) throw new Error(`git clone failed: ${result.stderr}`);
		return { branch: options.branch, repoUrl, success: true, targetDir, timestamp: new Date().toISOString() };
	}

	async setEnvVars(envVars: Record<string, string>): Promise<void> {
		this.#env = { ...this.#env, ...envVars };
	}

	// Preview URL tokens follow `@cloudflare/sandbox` 0.12.14 (`exposePort`,
	// `unexposePort`, `getExposedPorts`, `validatePortToken`): one token per
	// port in Durable Object storage, kept when an exposed port is exposed
	// again, and replaced only after `unexposePort()`.
	async exposePort(port: number, options: { hostname: string; name?: string; token?: string; sandboxName?: string }) {
		assertPreviewPort(port);
		const { backend } = await this.#connect();
		if (backend.previewOrigin === undefined && backend.previewFetch === undefined) {
			unsupported(
				"exposePort",
				`The ${this.#providerOrThrow().name} provider has no preview URLs on Orange. Use ORANGE_SANDBOX_PROVIDER=local or agentos for preview URLs.`,
			);
		}
		if (options.sandboxName === undefined) {
			throw new Error("Call exposePort() on a stub from getSandbox(), which carries the sandbox name preview URLs need");
		}
		if (options.token !== undefined) assertCustomToken(options.token);
		const tokens = await this.#portTokens();
		const token = options.token ?? tokens[String(port)]?.token ?? randomPreviewToken();
		const inUse = Object.entries(tokens).find(([other, entry]) => entry.token === token && other !== String(port));
		if (inUse !== undefined) {
			throw new Error(`Token '${token}' is already in use by port ${inUse[0]}. Please use a different token.`);
		}
		const url = previewUrl(port, options.sandboxName, options.hostname, token);
		await this.ctx.storage.put(portTokensKey, { ...tokens, [String(port)]: { name: options.name, token } } satisfies PortTokens);
		return { name: options.name, port, url };
	}

	async unexposePort(port: number): Promise<void> {
		assertPreviewPort(port);
		const tokens = await this.#portTokens();
		delete tokens[String(port)];
		await this.ctx.storage.put(portTokensKey, tokens);
	}

	async getExposedPorts(hostname: string, sandboxName?: string) {
		if (sandboxName === undefined) {
			throw new Error("Call getExposedPorts() on a stub from getSandbox(), which carries the sandbox name preview URLs need");
		}
		return Object.entries(await this.#portTokens())
			.map(([port, entry]) => ({ port: Number(port), status: "active" as const, url: previewUrl(Number(port), sandboxName, hostname, entry.token) }))
			.sort((a, b) => a.port - b.port);
	}

	async #portTokens(): Promise<PortTokens> {
		return (await this.ctx.storage.get<PortTokens>(portTokensKey)) ?? {};
	}

	/**
	 * Forwards a preview URL request to the exposed port when `token` is the
	 * port's token. Called by `proxyToSandbox`. The check runs here, in the
	 * object that owns the tokens, as in `@cloudflare/sandbox`, so a caller
	 * that reaches the object without the Worker still needs the token.
	 */
	async previewFetch(port: number, token: string, path: string, init: PreviewRequest): Promise<PreviewResponse> {
		const entry = (await this.#portTokens())[String(port)];
		if (entry === undefined || !previewTokensMatch(entry.token, token)) return invalidPreviewTokenResponse();
		const { backend } = await this.#connect();
		let response: Response;
		if (backend.previewOrigin !== undefined) {
			response = await fetch(new URL(path, backend.previewOrigin(port)), init);
		} else if (backend.previewFetch !== undefined) {
			response = await backend.previewFetch(port, new Request(new URL(path, "http://127.0.0.1"), init));
		} else {
			return invalidPreviewTokenResponse();
		}
		return { body: await response.arrayBuffer(), headers: [...response.headers], status: response.status };
	}

	async destroy(): Promise<void> {
		const storage = this.ctx.storage;
		const record = await storage.get<SandboxRecord>(sandboxRecordKey);
		if (record === undefined) return;
		for (const process of processesBySandbox.get(record.id)?.values() ?? []) process.abort.abort();
		processesBySandbox.delete(record.id);
		// The sandbox belongs to the provider that created it, even after
		// ORANGE_SANDBOX_PROVIDER changed.
		await sandboxProviderNamed(record.provider).destroy(this.#owner(), record.id);
		// Preview URLs of the destroyed sandbox must not reach the next one.
		await storage.delete(portTokensKey);
		await storage.delete(sandboxRecordKey);
		this.#backend = undefined;
	}

	createSession(): never {
		unsupported("createSession", "Use exec() with the cwd and env options.");
	}

	createCodeContext(): never {
		unsupported("createCodeContext", "Run code with exec(), for example exec('python3 script.py').");
	}

	runCode(): never {
		unsupported("runCode", "Run code with exec(), for example exec('python3 script.py').");
	}
}

// Preview ports are 1024-65535, as in `@cloudflare/sandbox` `validatePort`.
// Orange allows 3000, which Cloudflare reserves for its container control plane.
function isPreviewPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function assertPreviewPort(port: number): void {
	if (!isPreviewPort(port)) throw new Error(`Invalid port number: ${port}. Must be 1024-65535.`);
}

// The rules and messages of `@cloudflare/sandbox` `validateCustomToken`.
function assertCustomToken(token: string): void {
	if (token.length === 0) throw new Error("Custom token cannot be empty.");
	if (token.length > 16) {
		throw new Error(`Custom token too long. Maximum 16 characters allowed. Received: ${token.length} characters.`);
	}
	if (!/^[a-z0-9_]+$/.test(token)) {
		throw new Error(
			"Custom token must contain only lowercase letters (a-z), numbers (0-9), and underscores (_). Invalid token provided.",
		);
	}
}

// 12 random bytes as 16 lowercase base64 characters with `+` and `/` as `_`,
// as `@cloudflare/sandbox` `generatePortToken` does.
function randomPreviewToken(): string {
	return randomBytes(12).toString("base64").replace(/[+/]/g, "_").replace(/=/g, "").toLowerCase();
}

// Compares in constant time, as `@cloudflare/sandbox` does with
// `crypto.subtle.timingSafeEqual`. Only a length difference returns early.
function previewTokensMatch(expected: string, actual: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(actual);
	return a.length === b.length && timingSafeEqual(a, b);
}

// `@cloudflare/sandbox` `constructPreviewUrl`: http for localhost hostnames
// (local development), https otherwise. The sandbox name is lowercased because
// hostnames are case-insensitive.
function previewUrl(port: number, sandboxName: string, hostname: string, token: string): string {
	if (/[A-Z]/.test(sandboxName)) {
		throw new Error(`Preview URLs require lowercase sandbox IDs. Your ID "${sandboxName}" contains uppercase letters.`);
	}
	const host = hostname.split(":")[0];
	const local = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || hostname.startsWith("[::1]");
	return `${local ? "http" : "https"}://${port}-${sandboxName}-${token}.${hostname}/`;
}

// The body and status of `@cloudflare/sandbox` `invalidPreviewTokenResponse`.
function invalidPreviewTokenResponse(): PreviewResponse {
	const body = JSON.stringify({ error: "Access denied: Invalid token or port not exposed", code: "INVALID_TOKEN" });
	// SAFETY: TextEncoder.encode always returns a view over a fresh, non-shared ArrayBuffer, but @types/node types its buffer as ArrayBufferLike.
	return { body: new TextEncoder().encode(body).buffer as ArrayBuffer, headers: [["content-type", "application/json"]], status: 404 };
}

interface PreviewRequest {
	method: string;
	headers: [string, string][];
	body?: ArrayBuffer;
}

interface PreviewResponse {
	status: number;
	headers: [string, string][];
	body: ArrayBuffer;
}

interface DurableObjectStorageLike {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
}

interface NamespaceLike {
	idFromName(name: string): unknown;
	get(id: unknown): unknown;
}

/** Returns the stub for the Sandbox with this id, as `getSandbox` does on Cloudflare. */
interface SandboxStub {
	exposePort(port: number, options: { hostname: string; name?: string; token?: string; sandboxName: string }): Promise<unknown>;
	getExposedPorts(hostname: string, sandboxName: string): Promise<unknown>;
	getProcess(id: string): Promise<ProcessInfo | null>;
	getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>;
	killProcess(id: string, signal?: string): Promise<void>;
	listProcesses(): Promise<ProcessInfo[]>;
	startProcess(command: string, options?: unknown): Promise<ProcessInfo>;
	waitForProcessExit(id: string, timeout?: number): Promise<{ exitCode: number }>;
	waitForProcessLog(id: string, pattern: string | { source: string; flags: string }, timeout?: number): Promise<{ line: string }>;
	waitForProcessPort(id: string, port: number, options?: unknown): Promise<void>;
	previewFetch(port: number, token: string, path: string, init: PreviewRequest): Promise<PreviewResponse>;
}

function sandboxStub(namespace: NamespaceLike, name: string): SandboxStub {
	// SAFETY: The namespace is the Durable Object binding of the Sandbox class, so its stubs expose the Sandbox RPC methods. RPC stubs answer every property name, so they cannot be checked structurally.
	return namespace.get(namespace.idFromName(name)) as SandboxStub;
}

/** The `Process` object of the Sandbox SDK, backed by calls on the sandbox stub. */
export interface Process {
	readonly id: string;
	readonly pid?: number;
	readonly command: string;
	readonly status: ProcessInfo["status"];
	readonly startTime: Date;
	readonly endTime?: Date;
	readonly exitCode?: number;
	kill(signal?: string): Promise<void>;
	getStatus(): Promise<ProcessInfo["status"]>;
	getLogs(): Promise<{ stdout: string; stderr: string }>;
	waitForLog(pattern: string | RegExp, timeout?: number): Promise<{ line: string; match?: RegExpMatchArray }>;
	waitForPort(port: number, options?: object): Promise<void>;
	waitForExit(timeout?: number): Promise<{ exitCode: number }>;
}

// The Durable Object returns plain process data over RPC. The stub from
// getSandbox() turns it into a Process whose methods call back into the object.
function processObject(stub: SandboxStub, info: ProcessInfo): Process {
	const id = info.id;
	return {
		command: info.command,
		endTime: info.endTime === undefined ? undefined : new Date(info.endTime),
		exitCode: info.exitCode,
		async getLogs() {
			const { stdout, stderr } = await stub.getProcessLogs(id);
			return { stderr, stdout };
		},
		async getStatus() {
			const current = await stub.getProcess(id);
			if (current === null) throw new Error(`Process not found: ${id}`);
			return current.status;
		},
		id,
		kill: (signal) => stub.killProcess(id, signal),
		pid: info.pid,
		startTime: new Date(info.startTime),
		status: info.status,
		async waitForLog(pattern, timeout) {
			const wire = typeof pattern === "string" ? pattern : { flags: pattern.flags, source: pattern.source };
			const { line } = await stub.waitForProcessLog(id, wire, timeout);
			const match = typeof pattern === "string" ? undefined : (line.match(pattern) ?? undefined);
			return { line, match };
		},
		waitForExit: (timeout) => stub.waitForProcessExit(id, timeout),
		waitForPort: (port, options) => stub.waitForProcessPort(id, port, options),
	};
}

/** Returns the stub for the Sandbox with this id, as `getSandbox` does on Cloudflare. */
export function getSandbox(namespace: NamespaceLike, sandboxId: string, options?: { normalizeId?: boolean }) {
	// `normalizeId` lowercases the id, as on Cloudflare, so it can appear in a preview URL.
	const id = options?.normalizeId === true ? sandboxId.toLowerCase() : sandboxId;
	const stub = sandboxStub(namespace, id);
	return new Proxy(stub, {
		get(target, property, receiver) {
			switch (property) {
				// The object does not know its own name, which preview URLs contain.
				case "exposePort":
					return (port: number, options: { hostname: string; name?: string; token?: string }) =>
						target.exposePort(port, { ...options, sandboxName: id });
				case "getExposedPorts":
					return (hostname: string) => target.getExposedPorts(hostname, id);
				case "startProcess":
					return async (command: string, options?: unknown) =>
						processObject(target, await target.startProcess(command, options));
				case "getProcess":
					return async (processId: string) => {
						const info = await target.getProcess(processId);
						return info === null ? null : processObject(target, info);
					};
				case "listProcesses":
					return async () => (await target.listProcesses()).map((info) => processObject(target, info));
				default:
					return Reflect.get(target, property, receiver);
			}
		},
	});
}

// Preview URLs have the form http(s)://<port>-<sandbox name>-<token>.<hostname>,
// as on Cloudflare. Orange serves them through `orange dev`: a request with that
// host reaches the Worker, and `proxyToSandbox` sends it to the Sandbox object,
// which checks the token and forwards to the exposed port. The host is parsed as
// `@cloudflare/sandbox` 0.12.14 `extractSandboxRoute` does: the token follows
// the last hyphen, so sandbox names may contain hyphens and tokens may not.
function previewRoute(hostname: string): { port: number; sandboxName: string; token: string } | null {
	const label = hostname.slice(0, hostname.indexOf("."));
	const firstHyphen = label.indexOf("-");
	const lastHyphen = label.lastIndexOf("-");
	if (!hostname.includes(".") || firstHyphen === -1 || lastHyphen === firstHyphen) return null;
	const portText = label.slice(0, firstHyphen);
	const port = Number(portText);
	const sandboxName = label.slice(firstHyphen + 1, lastHyphen);
	const token = label.slice(lastHyphen + 1);
	if (!/^\d{4,5}$/.test(portText) || !isPreviewPort(port)) return null;
	if (!/^[a-z0-9_]{1,63}$/.test(token) || sandboxName.length === 0 || sandboxName.length > 63) return null;
	return { port, sandboxName, token };
}

export async function proxyToSandbox(request: Request, env: Record<string, unknown>): Promise<Response | null> {
	const url = new URL(request.url);
	const route = previewRoute(url.hostname);
	if (route === null) return null;
	const candidate = env.Sandbox ?? Object.values(env).find(isNamespace);
	if (!isNamespace(candidate)) return null;
	try {
		const stub = sandboxStub(candidate, route.sandboxName);
		const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
		const response = await stub.previewFetch(route.port, route.token, url.pathname + url.search, {
			body,
			headers: [...request.headers],
			method: request.method,
		});
		return new Response(response.body, { headers: response.headers, status: response.status });
	} catch (error) {
		console.error("Proxy routing error", error);
		return new Response("Proxy routing error", { status: 500 });
	}
}

function isNamespace(value: unknown): value is NamespaceLike {
	return typeof value === "object" && value !== null && "idFromName" in value && "get" in value;
}

export {
	DirectoryBackup,
	DirectoryBackupGateway,
	Files,
	S3Gateway,
	S3Mount,
	SandboxBackupError,
	SandboxFileError,
	SandboxProtocolError,
	SandboxS3MountError,
} from "./files.js";

export default { getSandbox, parseSSEStream, proxyToSandbox, Sandbox };
