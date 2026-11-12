import nodePromises from "node:fs/promises";

import {
	type AnyFunction,
	isFunction,
	mapGlobArgs,
	promiseWrapper,
	read,
	restoreError,
	restoreResult,
	specFor,
	syncWrapper,
	wrapperOf,
} from "./bundle-paths.js";

// `node:fs/promises` with the `/bundle` and `/tmp` mapping of `node:fs`.

type FsPromises = typeof nodePromises;

function wrapped<Name extends keyof FsPromises, F extends FsPromises[Name] & AnyFunction>(fn: F, name: Name): F {
	return promiseWrapper(fn, specFor(name), name);
}

export const access = wrapped(nodePromises.access, "access");
export const appendFile = wrapped(nodePromises.appendFile, "appendFile");
export const chmod = wrapped(nodePromises.chmod, "chmod");
export const chown = wrapped(nodePromises.chown, "chown");
export const copyFile = wrapped(nodePromises.copyFile, "copyFile");
export const cp = wrapped(nodePromises.cp, "cp");
export const lchown = wrapped(nodePromises.lchown, "lchown");
export const link = wrapped(nodePromises.link, "link");
export const lstat = wrapped(nodePromises.lstat, "lstat");
export const lutimes = wrapped(nodePromises.lutimes, "lutimes");
export const mkdir = wrapped(nodePromises.mkdir, "mkdir");
export const mkdtemp = wrapped(nodePromises.mkdtemp, "mkdtemp");
export const open = wrapped(nodePromises.open, "open");
export const opendir = wrapped(nodePromises.opendir, "opendir");
export const readdir = wrapped(nodePromises.readdir, "readdir");
export const readFile = wrapped(nodePromises.readFile, "readFile");
export const readlink = wrapped(nodePromises.readlink, "readlink");
export const realpath = wrapped(nodePromises.realpath, "realpath");
export const rename = wrapped(nodePromises.rename, "rename");
export const rm = wrapped(nodePromises.rm, "rm");
export const rmdir = wrapped(nodePromises.rmdir, "rmdir");
export const stat = wrapped(nodePromises.stat, "stat");
export const statfs = wrapped(nodePromises.statfs, "statfs");
export const symlink = wrapped(nodePromises.symlink, "symlink");
export const truncate = wrapped(nodePromises.truncate, "truncate");
export const unlink = wrapped(nodePromises.unlink, "unlink");
export const utimes = wrapped(nodePromises.utimes, "utimes");
export const writeFile = wrapped(nodePromises.writeFile, "writeFile");
// Node.js 24.4 added mkdtempDisposable(), which the pinned @types/node does not declare.
const nodeMkdtempDisposable: unknown = Reflect.get(nodePromises, "mkdtempDisposable");
export const mkdtempDisposable = isFunction(nodeMkdtempDisposable)
	? promiseWrapper(nodeMkdtempDisposable, specFor("mkdtempDisposable"), "mkdtempDisposable")
	: undefined;
export const glob = wrapperOf<typeof nodePromises.glob>(async function* (
	this: unknown,
	...args: unknown[]
): AsyncGenerator<unknown> {
	try {
		for await (const entry of Reflect.apply(nodePromises.glob, this, mapGlobArgs(args))) {
			yield restoreResult(entry);
		}
	} catch (error) {
		throw restoreError(error);
	}
});
// `watch` returns an async iterator instead of a promise.
export const watch = syncWrapper(nodePromises.watch, read, "watch");

export default {
	...nodePromises,
	access,
	appendFile,
	chmod,
	chown,
	copyFile,
	cp,
	glob,
	lchown,
	link,
	lstat,
	lutimes,
	mkdir,
	mkdtemp,
	mkdtempDisposable,
	open,
	opendir,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
	statfs,
	symlink,
	truncate,
	unlink,
	utimes,
	watch,
	writeFile,
};
