// The @cloudflare/sandbox 1.x `Files` class and its error types. On Cloudflare,
// `Files` runs `sandbox-shim` in the Container through `container.exec()`. On
// Orange it calls the sandbox provider behind `ctx.container` directly.
// API shape: https://developers.cloudflare.com/sandbox/reference/files/
import { posix } from "node:path";

import { containerBackend } from "./container.js";
import type { SandboxBackend } from "./providers.js";

type FileOperation = "readFile" | "writeFile" | "stat" | "lstat" | "readDirectory" | "mkdir" | "rename" | "remove";

function namedError(name: string, message: string, fields: Record<string, unknown>): Error {
	const error = new Error(message);
	Object.defineProperty(error, "name", { configurable: true, enumerable: false, value: name, writable: true });
	return Object.assign(error, fields);
}

function recognizer(name: string) {
	return {
		is(cause: unknown): boolean {
			return typeof cause === "object" && cause !== null && "name" in cause && cause.name === name;
		},
	};
}

export const SandboxFileError = recognizer("SandboxFileError");
export const SandboxProtocolError = recognizer("SandboxProtocolError");
export const SandboxS3MountError = recognizer("SandboxS3MountError");
export const SandboxBackupError = recognizer("SandboxBackupError");

function fileError(operation: FileOperation, path: string, cause: unknown, destination?: string): Error {
	const code = errnoOf(cause);
	const detail = cause instanceof Error ? cause.message : String(cause);
	return namedError("SandboxFileError", `${operation} ${path}: ${code}`, {
		code,
		destination,
		detail,
		operation,
		path,
	});
}

function errnoOf(cause: unknown): string {
	const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
	if (typeof code === "string" && /^E[A-Z0-9]+$/.test(code)) return code;
	const match = /\b(E[A-Z]{3,})\b/.exec(cause instanceof Error ? cause.message : String(cause));
	return match?.[1] ?? "UNKNOWN";
}

interface FileOperationOptions {
	cwd?: string;
	user?: string;
	signal?: AbortSignal;
}

type FileContent = string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array>;

async function contentBytes(content: FileContent): Promise<Uint8Array> {
	if (typeof content === "string") return new TextEncoder().encode(content);
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
	if (content instanceof Blob) return new Uint8Array(await content.arrayBuffer());
	return new Uint8Array(await new Response(content).arrayBuffer());
}

function absolutePath(path: string, options: FileOperationOptions = {}): string {
	if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
		throw new TypeError("A sandbox path must be a non-empty string without NUL");
	}
	if (path.startsWith("/")) return posix.normalize(path);
	if (options.cwd === undefined || !options.cwd.startsWith("/")) {
		throw new TypeError(`The relative path ${JSON.stringify(path)} needs an absolute cwd option`);
	}
	return posix.join(options.cwd, path);
}

interface OrangeContainer {
	[containerBackend](): Promise<SandboxBackend>;
}

export class Files {
	readonly #container: OrangeContainer;

	constructor(container: unknown) {
		if (typeof container !== "object" || container === null || !(containerBackend in container)) {
			throw new TypeError("Files needs ctx.container from a Durable Object class listed under wrangler containers");
		}
		// SAFETY: Only Orange's SandboxContainer defines the registered containerBackend method, and it resolves to a SandboxBackend. TypeScript cannot see that contract because `@cloudflare/sandbox` loads as a separate bundle.
		this.#container = container as OrangeContainer;
	}

	async #run<T>(operation: FileOperation, path: string, work: (backend: SandboxBackend) => Promise<T>, destination?: string): Promise<T> {
		const backend = await this.#container[containerBackend]();
		try {
			return await work(backend);
		} catch (cause) {
			throw fileError(operation, path, cause, destination);
		}
	}

	async readFile(path: string, options?: FileOperationOptions): Promise<Response> {
		const target = absolutePath(path, options);
		const bytes = await this.#run("readFile", target, (backend) => backend.readFile(target));
		return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
	}

	async writeFile(path: string, content: FileContent, options?: FileOperationOptions): Promise<void> {
		const target = absolutePath(path, options);
		const bytes = await contentBytes(content);
		await this.#run("writeFile", target, async (backend) => {
			if (!(await backend.exists(posix.dirname(target)))) {
				throw Object.assign(new Error(`ENOENT: no such directory ${posix.dirname(target)}`), { code: "ENOENT" });
			}
			await backend.writeFile(target, bytes);
		});
	}

	async #stat(operation: "stat" | "lstat", path: string, options?: FileOperationOptions) {
		const target = absolutePath(path, options);
		const info = await this.#run(operation, target, async (backend) => {
			if (backend.stat === undefined) throw new Error(`Files.${operation}() is not supported by this sandbox provider on Orange`);
			return backend.stat(target, operation === "stat");
		});
		return {
			accessedAt: new Date(info.atimeMs),
			changedAt: new Date(info.ctimeMs),
			gid: info.gid,
			mode: info.mode,
			modifiedAt: new Date(info.mtimeMs),
			size: BigInt(info.size),
			type: info.type,
			uid: info.uid,
		};
	}

	stat(path: string, options?: FileOperationOptions) {
		return this.#stat("stat", path, options);
	}

	lstat(path: string, options?: FileOperationOptions) {
		return this.#stat("lstat", path, options);
	}

	async readDirectory(path: string, options?: FileOperationOptions) {
		const target = absolutePath(path, options);
		const entries = await this.#run("readDirectory", target, (backend) => backend.list(target, false));
		return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory ? "directory" : "file" }));
	}

	async mkdir(path: string, options: FileOperationOptions & { recursive?: boolean } = {}): Promise<void> {
		const target = absolutePath(path, options);
		await this.#run("mkdir", target, (backend) => backend.mkdir(target, options.recursive ?? false));
	}

	async rename(source: string, destination: string, options?: FileOperationOptions): Promise<void> {
		const from = absolutePath(source, options);
		const to = absolutePath(destination, options);
		await this.#run("rename", from, (backend) => backend.rename(from, to), to);
	}

	async remove(path: string, options: FileOperationOptions & { recursive?: boolean; force?: boolean } = {}): Promise<void> {
		const target = absolutePath(path, options);
		await this.#run("remove", target, async (backend) => {
			if (options.force === true && !(await backend.exists(target))) return;
			if (options.recursive === true) {
				const quoted = `'${target.replaceAll("'", `'\\''`)}'`;
				const result = await backend.exec(`rm -rf -- ${quoted}`, { cwd: backend.cwd });
				if (result.exitCode !== 0) throw new Error(result.stderr);
				return;
			}
			await backend.deleteFile(target);
		});
	}
}

function notSupported(name: string): never {
	throw new Error(`${name} from @cloudflare/sandbox is not supported by Orange yet. Use Files and ctx.container.exec() instead.`);
}

export class S3Mount {
	constructor() {
		notSupported("S3Mount");
	}
}

export class DirectoryBackup {
	constructor() {
		notSupported("DirectoryBackup");
	}
}

// Workers export these entrypoints, so they must load. They refuse every call.
export class S3Gateway {
	fetch(): never {
		return notSupported("S3Gateway");
	}
}

export class DirectoryBackupGateway {
	fetch(): never {
		return notSupported("DirectoryBackupGateway");
	}
}
