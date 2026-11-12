import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// workerd gives every IoContext its own empty /tmp and deletes it with the IoContext. A Worker
// event's IoContext ends after its response and waitUntil() tasks, and a Durable Object keeps one
// IoContext for its lifetime. Code outside every IoContext sees an empty /tmp that it cannot write;
// Orange instead gives that code one writable /tmp for the process, as in Node.js.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/worker-fs.c%2B%2B#L59-L180
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/io-context.h#L219-L221
// Orange keeps each /tmp in a private host directory instead of memory, so it never reaches the
// host's /tmp.

/** The runner sets this to the directory that holds every /tmp of the process, such as the build directory. */
const tmpParentKey = Symbol.for("open-orange.node-fs.tmp-parent");

let processRoot: string | undefined;

/** The directory that holds this process's /tmp directories, created on first use. */
function root(): string {
	if (processRoot !== undefined) return processRoot;
	const parent: unknown = Reflect.get(globalThis, tmpParentKey);
	const created = mkdtempSync(join(typeof parent === "string" ? parent : tmpdir(), "tmp-"));
	// Paths that node:fs returns, such as realpath() results, name the canonical directory, so
	// mapping them back to /tmp needs the canonical form. macOS puts os.tmpdir() behind a symlink.
	processRoot = realpathSync(created);
	process.once("exit", () => rmSync(created, { force: true, recursive: true }));
	return processRoot;
}

let outsideEventDirectory: string | undefined;

/** The directory behind /tmp outside every event. It lives as long as the process. */
export function outsideEventTmpDirectory(): string {
	if (outsideEventDirectory === undefined) {
		const directory = join(root(), "outside-event");
		mkdirSync(directory);
		outsideEventDirectory = directory;
	}
	return outsideEventDirectory;
}

/** One event's /tmp. It is created on first use and removed when the event ends. */
export class WorkerTmp {
	#directory: string | undefined;
	#ended = false;

	/** The host directory behind this /tmp, or undefined once the event has ended. */
	directory(): string | undefined {
		if (this.#ended) return undefined;
		if (this.#directory === undefined) {
			const directory = join(root(), randomUUID());
			mkdirSync(directory);
			this.#directory = directory;
		}
		return this.#directory;
	}

	/** The host directory, if the event used its /tmp, even after the event ended. */
	createdDirectory(): string | undefined {
		return this.#directory;
	}

	/** Ends this /tmp and removes its files. Later events never see them. */
	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		const directory = this.#directory;
		if (directory === undefined) return;
		// `rm` does not follow symlinks, so a link to a host directory loses only the link. A
		// directory that the Worker made unreadable stays until the process exits.
		void rm(directory, { force: true, recursive: true }).catch(() => undefined);
	}
}

const currentTmp = new AsyncLocalStorage<WorkerTmp>();

export function runWithWorkerTmp<Result>(tmp: WorkerTmp, callback: () => Result): Result {
	return currentTmp.run(tmp, callback);
}

export function currentWorkerTmp(): WorkerTmp | undefined {
	return currentTmp.getStore();
}

/** The host directories that node:fs can name for the current /tmp, for mapping host paths back. */
export function knownTmpDirectories(): string[] {
	if (processRoot === undefined) return [];
	const current = currentTmp.getStore()?.createdDirectory();
	return [
		...(current === undefined ? [] : [current]),
		join(processRoot, "outside-event"),
	];
}

/** Whether a host path is in a /tmp directory of this process. */
export function isWorkerTmpHostPath(path: string): boolean {
	return processRoot !== undefined && path.startsWith(`${processRoot}/`);
}
