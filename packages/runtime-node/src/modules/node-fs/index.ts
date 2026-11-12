import nodeFs from "node:fs";
import { promisify } from "node:util";

import {
	type AnyFunction,
	callbackWrapper,
	mapGlobArgs,
	read,
	restoreError,
	restoreResult,
	specFor,
	syncWrapper,
	write as writeAccess,
	isFunction,
	wrapperOf,
} from "./bundle-paths.js";
import wrappedPromises from "./promises-impl.js";

// Orange uses the host file system through Node.js `fs`. `/bundle` is the read-only directory that
// holds the Worker and `/tmp` is the event's private directory, as in workerd.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/worker-fs.c%2B%2B#L1306-L1315

export * from "node:fs";

type Fs = typeof nodeFs;

function wrapped<Name extends keyof Fs, F extends Fs[Name] & AnyFunction>(fn: F, name: Name): F {
	if (name.endsWith("Sync")) {
		const syscall = name.slice(0, -"Sync".length);
		return syncWrapper(fn, specFor(syscall), syscall);
	}
	return callbackWrapper(fn, specFor(name), name);
}

export const access = wrapped(nodeFs.access, "access");
export const accessSync = wrapped(nodeFs.accessSync, "accessSync");
export const appendFile = wrapped(nodeFs.appendFile, "appendFile");
export const appendFileSync = wrapped(nodeFs.appendFileSync, "appendFileSync");
export const chmod = wrapped(nodeFs.chmod, "chmod");
export const chmodSync = wrapped(nodeFs.chmodSync, "chmodSync");
export const chown = wrapped(nodeFs.chown, "chown");
export const chownSync = wrapped(nodeFs.chownSync, "chownSync");
export const copyFile = wrapped(nodeFs.copyFile, "copyFile");
export const copyFileSync = wrapped(nodeFs.copyFileSync, "copyFileSync");
export const cp = wrapped(nodeFs.cp, "cp");
export const cpSync = wrapped(nodeFs.cpSync, "cpSync");
export const lchown = wrapped(nodeFs.lchown, "lchown");
export const lchownSync = wrapped(nodeFs.lchownSync, "lchownSync");
export const link = wrapped(nodeFs.link, "link");
export const linkSync = wrapped(nodeFs.linkSync, "linkSync");
export const lstat = wrapped(nodeFs.lstat, "lstat");
export const lstatSync = wrapped(nodeFs.lstatSync, "lstatSync");
export const lutimes = wrapped(nodeFs.lutimes, "lutimes");
export const lutimesSync = wrapped(nodeFs.lutimesSync, "lutimesSync");
export const mkdir = wrapped(nodeFs.mkdir, "mkdir");
export const mkdirSync = wrapped(nodeFs.mkdirSync, "mkdirSync");
export const mkdtemp = wrapped(nodeFs.mkdtemp, "mkdtemp");
export const mkdtempSync = wrapped(nodeFs.mkdtempSync, "mkdtempSync");
export const open = wrapped(nodeFs.open, "open");
export const openSync = wrapped(nodeFs.openSync, "openSync");
export const opendir = wrapped(nodeFs.opendir, "opendir");
export const opendirSync = wrapped(nodeFs.opendirSync, "opendirSync");
export const readdir = wrapped(nodeFs.readdir, "readdir");
export const readdirSync = wrapped(nodeFs.readdirSync, "readdirSync");
export const readFile = wrapped(nodeFs.readFile, "readFile");
export const readFileSync = wrapped(nodeFs.readFileSync, "readFileSync");
export const readlink = wrapped(nodeFs.readlink, "readlink");
export const readlinkSync = wrapped(nodeFs.readlinkSync, "readlinkSync");
export const rename = wrapped(nodeFs.rename, "rename");
export const renameSync = wrapped(nodeFs.renameSync, "renameSync");
export const rm = wrapped(nodeFs.rm, "rm");
export const rmSync = wrapped(nodeFs.rmSync, "rmSync");
export const rmdir = wrapped(nodeFs.rmdir, "rmdir");
export const rmdirSync = wrapped(nodeFs.rmdirSync, "rmdirSync");
export const stat = wrapped(nodeFs.stat, "stat");
export const statSync = wrapped(nodeFs.statSync, "statSync");
export const statfs = wrapped(nodeFs.statfs, "statfs");
export const statfsSync = wrapped(nodeFs.statfsSync, "statfsSync");
export const symlink = wrapped(nodeFs.symlink, "symlink");
export const symlinkSync = wrapped(nodeFs.symlinkSync, "symlinkSync");
export const truncate = wrapped(nodeFs.truncate, "truncate");
export const truncateSync = wrapped(nodeFs.truncateSync, "truncateSync");
export const unlink = wrapped(nodeFs.unlink, "unlink");
export const unlinkSync = wrapped(nodeFs.unlinkSync, "unlinkSync");
export const utimes = wrapped(nodeFs.utimes, "utimes");
export const utimesSync = wrapped(nodeFs.utimesSync, "utimesSync");
export const writeFile = wrapped(nodeFs.writeFile, "writeFile");
export const writeFileSync = wrapped(nodeFs.writeFileSync, "writeFileSync");
// Node.js 24.4 added mkdtempDisposableSync(), which the pinned @types/node does not declare.
const nodeMkdtempDisposableSync: unknown = Reflect.get(nodeFs, "mkdtempDisposableSync");
export const mkdtempDisposableSync = isFunction(nodeMkdtempDisposableSync)
	? syncWrapper(nodeMkdtempDisposableSync, specFor("mkdtempDisposable"), "mkdtempDisposable")
	: undefined;

export const globSync = wrapperOf<typeof nodeFs.globSync>(function (
	this: unknown,
	...args: unknown[]
): unknown {
	try {
		return restoreResult(Reflect.apply(nodeFs.globSync, this, mapGlobArgs(args)));
	} catch (error) {
		throw restoreError(error);
	}
});
export const glob = wrapperOf<typeof nodeFs.glob>(function (this: unknown, ...args: unknown[]): unknown {
	const mapped = mapGlobArgs(args);
	const callback = mapped.at(-1);
	if (typeof callback === "function") {
		mapped[mapped.length - 1] = (error: unknown, matches: unknown) =>
			Reflect.apply(callback, undefined, [restoreError(error), restoreResult(matches)]);
	}
	return Reflect.apply(nodeFs.glob, this, mapped);
});
export const realpath = Object.assign(wrapped(nodeFs.realpath, "realpath"), {
	native: callbackWrapper(nodeFs.realpath.native, read, "realpath"),
});
export const realpathSync = Object.assign(wrapped(nodeFs.realpathSync, "realpathSync"), {
	native: syncWrapper(nodeFs.realpathSync.native, read, "realpath"),
});

// These return an object instead of taking a callback, so they map like sync calls.
export const createReadStream = syncWrapper(nodeFs.createReadStream, read, "open");
export const createWriteStream = syncWrapper(nodeFs.createWriteStream, writeAccess, "open");
export const openAsBlob = syncWrapper(nodeFs.openAsBlob, read, "open");
export const watch = syncWrapper(nodeFs.watch, read, "watch");
export const watchFile = syncWrapper(nodeFs.watchFile, read, "watch");
export const unwatchFile = syncWrapper(nodeFs.unwatchFile, read, "watch");
export const existsSync = syncWrapper(nodeFs.existsSync, read, "access");

// `exists` calls back with a boolean instead of an error.
export const exists = Object.assign(
	(path: nodeFs.PathLike, callback: (exists: boolean) => void): void => {
		process.nextTick(callback, existsSync(path));
	},
	{
		[promisify.custom]: (path: nodeFs.PathLike): Promise<boolean> =>
			Promise.resolve(existsSync(path)),
	},
);

export const promises = wrappedPromises;

export default {
	...nodeFs,
	access,
	accessSync,
	appendFile,
	appendFileSync,
	chmod,
	chmodSync,
	chown,
	chownSync,
	copyFile,
	copyFileSync,
	cp,
	cpSync,
	createReadStream,
	createWriteStream,
	exists,
	existsSync,
	glob,
	globSync,
	lchown,
	lchownSync,
	link,
	linkSync,
	lstat,
	lstatSync,
	lutimes,
	lutimesSync,
	mkdir,
	mkdirSync,
	mkdtemp,
	mkdtempDisposableSync,
	mkdtempSync,
	open,
	openAsBlob,
	openSync,
	opendir,
	opendirSync,
	promises,
	readdir,
	readdirSync,
	readFile,
	readFileSync,
	readlink,
	readlinkSync,
	realpath,
	realpathSync,
	rename,
	renameSync,
	rm,
	rmSync,
	rmdir,
	rmdirSync,
	stat,
	statSync,
	statfs,
	statfsSync,
	symlink,
	symlinkSync,
	truncate,
	truncateSync,
	unlink,
	unlinkSync,
	unwatchFile,
	utimes,
	utimesSync,
	watch,
	watchFile,
	writeFile,
	writeFileSync,
};
