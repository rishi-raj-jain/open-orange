import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// workerd's fs tests write to /tmp. On plain Node.js, /tmp is the host /tmp, so the plain Node.js
// run rewrites every /tmp path in the test module to a scratch directory that it owns. Orange gives
// each Worker a private /tmp, so it runs the test module unmodified.

// `/tmp` as a whole path segment: after a quote, space, bracket, or `file://`, and not followed by
// more name characters. `/var/tmp` and `/tmpfile` do not match.
const tmpPath = /(?<=^|[^\w.$\\/-]|file:\/\/)\/tmp(?![\w.-])/gm;
// `\/tmp` inside a regular expression literal.
const escapedTmpPath = /(?<![\w\\])\\\/tmp(?![\w.-])/g;

/**
 * Rewrites every `/tmp` path in a module source to `scratchTmp`. Throws when a `/tmp` reference is
 * left, so a path the rewrite cannot see fails the file instead of reaching the host /tmp.
 */
export function remapTmpPaths(source: string, scratchTmp: string): string {
	if (!/^\/[\w/.-]+$/.test(scratchTmp)) {
		throw new Error(`Scratch directory ${scratchTmp} is not a plain absolute path`);
	}
	const escapedScratch = scratchTmp.replaceAll("/", "\\/");
	const rewritten = source
		.replace(escapedTmpPath, () => escapedScratch)
		.replace(tmpPath, () => scratchTmp);
	const leftover = rewritten
		.split("\n")
		.map((line, index) => ({
			line: index + 1,
			text: line.replaceAll(scratchTmp, "").replaceAll(escapedScratch, ""),
		}))
		.filter(({ text }) => text.includes("/tmp"));
	if (leftover.length > 0) {
		throw new Error(
			`The /tmp rewrite left ${leftover.length} /tmp references, so the file would reach the host /tmp: ${leftover
				.slice(0, 5)
				.map(({ line, text }) => `line ${line}: ${text.trim().slice(0, 120)}`)
				.join("; ")}`,
		);
	}
	return rewritten;
}

export interface Scratch {
	/** Directory the runner created. Removing it removes everything the tests wrote. */
	root: string;
	/** What the test module sees as `/tmp`. */
	tmp: string;
}

export const scratchPrefix = "oo-fs-scratch-";

export async function createScratch(): Promise<Scratch> {
	const root = await mkdtemp(join(tmpdir(), scratchPrefix));
	const tmp = join(root, "tmp");
	await mkdir(tmp);
	return { root, tmp };
}

// `rm` does not follow symlinks, so a test symlink to / or to the home directory only loses the link.
async function removeTree(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true });
	} catch {
		// A test can chmod its /tmp to 0o000, which blocks listing it. Restore only that one directory,
		// never recursively, and only when it is a real directory and not a symlink.
		const stats = await lstat(path).catch(() => undefined);
		if (stats?.isDirectory() === true && !stats.isSymbolicLink()) {
			await chmod(path, 0o700);
		}
		await rm(path, { recursive: true, force: true });
	}
}

export async function removeScratch(scratch: Scratch): Promise<void> {
	try {
		await removeTree(scratch.root);
	} catch (error: unknown) {
		throw new Error(
			`Could not remove the scratch directory ${scratch.root}. Remove it by hand: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

interface EntryState {
	type: "file" | "directory" | "symlink" | "other";
	mode: number;
	uid: number;
	gid: number;
	mtimeMs: number;
}

/** Top-level entries of each watched host directory, from `lstat`, so links are never followed. */
export type HostSnapshot = Map<string, Map<string, EntryState>>;

export interface WatchedHost {
	tmp: string;
	home: string;
	/** The working directory of `orange dev`, where a relative path would land. */
	repository: string;
}

export function watchedHost(repositoryRoot: string): WatchedHost {
	return { tmp: tmpdir(), home: homedir(), repository: repositoryRoot };
}

export async function snapshotHost(host: WatchedHost): Promise<HostSnapshot> {
	const snapshot: HostSnapshot = new Map();
	for (const directory of new Set(Object.values(host))) {
		const entries = new Map<string, EntryState>();
		for (const name of await readdir(directory)) {
			const stats = await lstat(join(directory, name)).catch(() => undefined);
			// The entry was removed between readdir and lstat, so it is absent from this snapshot.
			if (stats === undefined) continue;
			entries.set(name, {
				type: stats.isSymbolicLink()
					? "symlink"
					: stats.isDirectory()
						? "directory"
						: stats.isFile()
							? "file"
							: "other",
				mode: stats.mode,
				uid: stats.uid,
				gid: stats.gid,
				mtimeMs: stats.mtimeMs,
			});
		}
		snapshot.set(directory, entries);
	}
	return snapshot;
}

/** Names the test file could create: every path segment in its string and template literals. */
export function pathVocabulary(sources: readonly string[]): Set<string> {
	const names = new Set<string>();
	for (const source of sources) {
		for (const [, , text] of source.matchAll(/(['"`])((?:(?!\1)[^\n\\]){1,300})\1/g)) {
			for (const name of text?.split(/[^\w.-]+/) ?? []) {
				if (name !== "" && name !== "." && name !== "..") names.add(name);
			}
		}
	}
	return names;
}

// Host entries that the runner itself creates or changes around every file.
const runnerOwned = (name: string) =>
	name.startsWith(scratchPrefix) ||
	name.startsWith("oo-upstream-") ||
	// The build directory of `orange dev`. The runner kills `orange dev`, so it stays behind.
	name.startsWith("open-orange-dev-") ||
	// The compile cache of tsx, which runs `orange dev`.
	name === `tsx-${process.getuid?.() ?? ""}`;

export interface HostChanges {
	/** Changes the file could have made. Any of them stops the run. */
	blocking: string[];
	/** Changes by other processes on the host, such as a new log file of another tool. */
	unattributed: string[];
}

/**
 * Host entries added, removed, or changed between two snapshots, except the runner's own. A change
 * blocks when it is in the repository root, adds or removes a home entry, changes a mode or owner
 * (as a recursive chmod through a symlink would), or is a /tmp entry that the test file names.
 */
export function hostChanges(
	host: WatchedHost,
	before: HostSnapshot,
	after: HostSnapshot,
	vocabulary: ReadonlySet<string>,
): HostChanges {
	const changes: HostChanges = { blocking: [], unattributed: [] };
	// `mkdtemp("/tmp/testdir-")` creates `testdir-<random>`.
	const prefixes = [...vocabulary].filter((name) => /[-_]$/.test(name));
	const named = (name: string) =>
		vocabulary.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
	for (const [directory, entries] of after) {
		const earlier = before.get(directory) ?? new Map<string, EntryState>();
		for (const name of new Set([...earlier.keys(), ...entries.keys()])) {
			if (runnerOwned(name)) continue;
			const path = join(directory, name);
			const was = earlier.get(name);
			const now = entries.get(name);
			let change: string;
			let ownership = false;
			if (was === undefined) {
				change = `added ${path} (${now?.type})`;
			} else if (now === undefined) {
				change = `removed ${path} (${was.type})`;
			} else {
				const changed = (["type", "mode", "uid", "gid", "mtimeMs"] as const).filter(
					(key) => was[key] !== now[key],
				);
				if (changed.length === 0) continue;
				ownership = changed.some((key) => key !== "mtimeMs");
				change = `changed ${path}: ${changed.map((key) => `${key} ${key === "mode" ? was[key].toString(8) : was[key]} -> ${key === "mode" ? now[key].toString(8) : now[key]}`).join(", ")}`;
			}
			const blocking =
				directory === host.repository ||
				(directory === host.home && (was === undefined || now === undefined)) ||
				ownership ||
				(directory === host.tmp && named(name));
			(blocking ? changes.blocking : changes.unattributed).push(change);
		}
	}
	return changes;
}
