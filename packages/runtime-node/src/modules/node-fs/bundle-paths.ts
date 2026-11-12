import nodeFs from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import {
	currentWorkerTmp,
	isWorkerTmpHostPath,
	knownTmpDirectories,
	outsideEventTmpDirectory,
} from "../../internal/worker-tmp.js";

// Maps the Worker's virtual paths to host paths: `/bundle` is the Worker's read-only directory,
// `/tmp` is the current event's private directory, and relative paths resolve against the
// Worker's virtual working directory. Every other absolute path is the host path.

/** `link-target` is a symlink's target: it is mapped, but never resolved or checked for writes. */
export type Access = "read" | "write" | "link-target";
export type AnyFunction = (...args: never[]) => unknown;
export type PathSpec = ReadonlyArray<
	Access | ((args: readonly unknown[]) => Access) | undefined
>;

/** The runtime sets this to the host directory that `/bundle` names. */
const bundleRootKey = Symbol.for("open-orange.node-fs.bundle-root");

function bundleRoot(): string | undefined {
	const root: unknown = Reflect.get(globalThis, bundleRootKey);
	return typeof root === "string" ? root : undefined;
}

/** The Worker's virtual working directory, which `process.chdir()` sets. workerd starts it at /bundle. */
export const workerCwdKey = Symbol.for("open-orange.node-process.cwd");

function workerCwd(): string {
	const value: unknown = Reflect.get(globalThis, workerCwdKey);
	return typeof value === "string" ? value : "/bundle";
}

/** The part of `path` below `root`, such as `/a` for `/tmp/a`, or undefined when it is not below it. */
function below(path: string, root: string): string | undefined {
	if (path === root) return "";
	return path.startsWith(`${root}/`) ? path.slice(root.length) : undefined;
}

interface HostTarget {
	host: string;
	writable: boolean;
}

/** The host path behind a normalized absolute Worker path, or undefined for a plain host path. */
function hostTarget(path: string): HostTarget | undefined {
	// A path that is already mapped stays as it is, such as the host path that a stream passes to a
	// custom `fs.open()`. On Linux the build directory, and so every mapped path, is under /tmp.
	const root = bundleRoot();
	if (root !== undefined && below(path, root) !== undefined) return { host: path, writable: false };
	if (isWorkerTmpHostPath(path)) return { host: path, writable: true };
	const inBundle = below(path, "/bundle");
	if (inBundle !== undefined) {
		return { host: root === undefined ? path : `${root}${inBundle}`, writable: false };
	}
	const inTmp = below(path, "/tmp");
	if (inTmp !== undefined) {
		// Outside every event, such as during module evaluation, /tmp is one writable directory
		// that lives as long as the process, as in Node.js. Workerd makes it read-only there.
		const directory = currentWorkerTmp()?.directory() ?? outsideEventTmpDirectory();
		return { host: `${directory}${inTmp}`, writable: true };
	}
	return undefined;
}

/** The host path of an absolute Worker path. */
export function hostPathOf(path: string): string {
	const normalized = posix.normalize(path);
	return hostTarget(normalized)?.host ?? normalized;
}

interface WorkerPath {
	/** Normalized and absolute. */
	path: string;
	relative: boolean;
}

/** The Worker path that a path argument names, or undefined for a file descriptor or other value. */
function workerPathOf(value: unknown, resolveRelative: boolean): WorkerPath | undefined {
	let path: string;
	if (typeof value === "string") {
		path = value;
	} else if (value instanceof URL) {
		if (value.protocol !== "file:") return undefined;
		try {
			path = fileURLToPath(value);
		} catch {
			return undefined;
		}
	} else if (value instanceof Uint8Array) {
		path = Buffer.from(value).toString("utf8");
	} else {
		return undefined;
	}
	if (path.length === 0) return undefined;
	if (path.startsWith("/")) return { path: posix.normalize(path), relative: false };
	// A relative path names a path under the Worker's working directory, not the host's.
	return resolveRelative ? { path: posix.resolve(workerCwd(), path), relative: true } : undefined;
}

/** The host path that a path argument names, or undefined for a file descriptor or other value. */
export function hostPathOfArgument(value: unknown): string | undefined {
	const named = workerPathOf(value, true);
	if (named === undefined) return undefined;
	return hostTarget(named.path)?.host ?? named.path;
}

/** Whether a path argument names a file in a /tmp, by its Worker path or by its host path. */
export function isTmpPath(value: unknown): boolean {
	const named = workerPathOf(value, true);
	if (named === undefined) return false;
	return below(named.path, "/tmp") !== undefined || isWorkerTmpHostPath(named.path);
}

/** Puts the Worker path back into text that names a mapped host path. */
function toWorkerPaths(text: string): string {
	let result = text;
	for (const directory of knownTmpDirectories()) {
		result = result.replaceAll(directory, "/tmp");
	}
	const root = bundleRoot();
	return root === undefined ? result : result.replaceAll(root, "/bundle");
}

/** Puts Worker paths back into an error that names mapped host paths. */
export function restoreError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	for (const key of ["message", "path", "dest"] as const) {
		const value: unknown = Reflect.get(error, key);
		if (typeof value === "string") Reflect.set(error, key, toWorkerPaths(value));
	}
	return error;
}

/** Puts Worker paths back into a result that names paths, such as a realpath() or a Dirent. */
export function restoreResult(value: unknown): unknown {
	if (typeof value === "string") return toWorkerPaths(value);
	if (Buffer.isBuffer(value)) {
		const text = value.toString("utf8");
		const restored = toWorkerPaths(text);
		return restored === text ? value : Buffer.from(restored);
	}
	if (Array.isArray(value)) return value.map(restoreResult);
	if (value instanceof nodeFs.Dirent) {
		value.parentPath = toWorkerPaths(value.parentPath);
		return value;
	}
	// mkdtempDisposable() returns `{ path, remove }`.
	if (typeof value === "object" && value !== null && typeof Reflect.get(value, "path") === "string") {
		Reflect.set(value, "path", toWorkerPaths(Reflect.get(value, "path")));
	}
	return value;
}

// workerd rejects every write under /bundle with EPERM.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/node/tests/fs-dir-test.js#L88
function permissionError(syscall: string, path: string): NodeJS.ErrnoException {
	return Object.assign(
		new Error(`EPERM: operation not permitted, ${syscall} '${path}'`),
		{ errno: -1, code: "EPERM", syscall, path },
	);
}

export interface MappedPaths {
	args: unknown[];
	/** Set when a write targets a read-only directory. */
	error?: NodeJS.ErrnoException;
}

export function mapPaths(
	args: readonly unknown[],
	spec: PathSpec,
	syscall: string,
): MappedPaths {
	const mapped = [...args];
	for (const [index, entry] of spec.entries()) {
		if (entry === undefined) continue;
		const access = typeof entry === "function" ? entry(args) : entry;
		// A relative symlink target is relative to the link, so it stays as it is.
		const named = workerPathOf(args[index], access !== "link-target");
		if (named === undefined) continue;
		const target = hostTarget(named.path);
		if (target === undefined) {
			if (named.relative) mapped[index] = named.path;
			continue;
		}
		if (access === "write" && !target.writable) {
			return { args: mapped, error: permissionError(syscall, named.path) };
		}
		mapped[index] = target.host;
	}
	return { args: mapped };
}

const writeFlags =
	nodeFs.constants.O_WRONLY |
	nodeFs.constants.O_RDWR |
	nodeFs.constants.O_CREAT |
	nodeFs.constants.O_TRUNC |
	nodeFs.constants.O_APPEND;

function isWriteFlag(flags: unknown): boolean {
	if (typeof flags === "number") return (flags & writeFlags) !== 0;
	return typeof flags === "string" && /[wa+]/.test(flags);
}

export const read: PathSpec = ["read"];
export const write: PathSpec = ["write"];

/** Path arguments of every `fs` function that takes paths, by the access each needs. */
export const pathSpecs: Readonly<Record<string, PathSpec>> = {
	access: read,
	appendFile: write,
	chmod: write,
	chown: write,
	copyFile: ["read", "write"],
	cp: ["read", "write"],
	lchown: write,
	link: ["read", "write"],
	lstat: read,
	lutimes: write,
	mkdir: write,
	mkdtemp: write,
	mkdtempDisposable: write,
	open: [(args) => (isWriteFlag(args[1]) ? "write" : "read")],
	opendir: read,
	readdir: read,
	readFile: read,
	readlink: read,
	realpath: read,
	rename: ["write", "write"],
	rm: write,
	rmdir: write,
	stat: read,
	statfs: read,
	symlink: ["link-target", "write"],
	truncate: write,
	unlink: write,
	utimes: write,
	writeFile: write,
};

/** Calls whose result names paths, which must name Worker paths instead of host paths. */
const pathResults: ReadonlySet<string> = new Set([
	"mkdir",
	"mkdtemp",
	"mkdtempDisposable",
	"readdir",
	"readlink",
	"realpath",
]);

export function specFor(name: string): PathSpec {
	const spec = pathSpecs[name];
	if (spec === undefined) throw new Error(`fs.${name} has no path spec`);
	return spec;
}

export function isFunction(value: unknown): value is AnyFunction {
	return typeof value === "function";
}

// Every wrapper forwards its arguments to `fn` after path mapping and returns
// what `fn` returns, so it can stand in for `fn` under `fn`'s own type.
export function wrapperOf<F extends AnyFunction>(wrapper: AnyFunction): F {
	// SAFETY: The wrapper accepts every argument list `fn` accepts and returns `fn`'s result, but one variadic function cannot be typed as an arbitrary, often overloaded, `F`.
	return wrapper as F;
}

function resultOf(syscall: string, value: unknown): unknown {
	return pathResults.has(syscall) ? restoreResult(value) : value;
}

export function syncWrapper<F extends AnyFunction>(
	fn: F,
	spec: PathSpec,
	syscall: string,
): F {
	return wrapperOf<F>(function (this: unknown, ...args: unknown[]): unknown {
		const mapped = mapPaths(args, spec, syscall);
		if (mapped.error !== undefined) throw mapped.error;
		try {
			return resultOf(syscall, Reflect.apply(fn, this, mapped.args));
		} catch (error) {
			throw restoreError(error);
		}
	});
}

export function callbackWrapper<F extends AnyFunction>(
	fn: F,
	spec: PathSpec,
	syscall: string,
): F {
	return wrapperOf<F>(function (this: unknown, ...args: unknown[]): unknown {
		const mapped = mapPaths(args, spec, syscall);
		const callback = mapped.args.at(-1);
		// Without a callback, Node.js throws its own argument error.
		if (typeof callback !== "function") {
			return Reflect.apply(fn, this, mapped.args);
		}
		if (mapped.error !== undefined) {
			process.nextTick(callback, mapped.error);
			return undefined;
		}
		mapped.args[mapped.args.length - 1] = (error: unknown, ...results: unknown[]) =>
			Reflect.apply(callback, undefined, [
				restoreError(error),
				...results.map((result) => resultOf(syscall, result)),
			]);
		return Reflect.apply(fn, this, mapped.args);
	});
}

export function promiseWrapper<F extends AnyFunction>(
	fn: F,
	spec: PathSpec,
	syscall: string,
): F {
	return wrapperOf<F>(async function (this: unknown, ...args: unknown[]): Promise<unknown> {
		const mapped = mapPaths(args, spec, syscall);
		if (mapped.error !== undefined) throw mapped.error;
		try {
			return resultOf(syscall, await Reflect.apply(fn, this, mapped.args));
		} catch (error) {
			throw restoreError(error);
		}
	});
}

/** A glob pattern with a Worker path prefix mapped to the host. */
function mapGlobPattern(pattern: unknown): unknown {
	if (typeof pattern !== "string" || !pattern.startsWith("/")) return pattern;
	for (const root of ["/bundle", "/tmp"]) {
		const rest = below(pattern, root);
		if (rest === undefined) continue;
		const target = hostTarget(root);
		return target === undefined ? pattern : `${target.host}${rest}`;
	}
	return pattern;
}

/**
 * Glob arguments with Worker paths mapped. Without a `cwd` option, Node.js globs the host's
 * working directory, so the Worker's virtual one is passed instead.
 */
export function mapGlobArgs(args: readonly unknown[]): unknown[] {
	const [pattern, options, ...rest] = args;
	const patterns = Array.isArray(pattern) ? pattern.map(mapGlobPattern) : mapGlobPattern(pattern);
	const given = typeof options === "object" && options !== null ? options : {};
	const named = workerPathOf(Reflect.get(given, "cwd") ?? workerCwd(), true);
	const cwd = named === undefined ? Reflect.get(given, "cwd") : (hostTarget(named.path)?.host ?? named.path);
	const mappedOptions = { ...given, cwd };
	// A callback in the options position stays last.
	return typeof options === "function"
		? [patterns, mappedOptions, options, ...rest]
		: [patterns, mappedOptions, ...rest];
}
