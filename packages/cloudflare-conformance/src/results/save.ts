import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
	areaOf,
	fileName,
	isRemapped,
	isScored,
	isWorkerdOnly,
	NODE_AREA,
	NOT_SUPPORTED_CAUSE,
	type SummaryRow,
	type SummaryStatus,
} from "../upstream/classify.js";
import { readRunResults, summaryFileName } from "../upstream/report.js";

const execFileAsync = promisify(execFile);

/**
 * Bump when a field changes meaning or is removed. Adding a field keeps the version.
 * Version 2 leaves Node.js compat tests that fail on plain Node.js out of every score.
 * Version 3 adds the `remapped-pass` and `remapped-fail` statuses and `totals.remapped`.
 */
export const resultsSchemaVersion = 3;

export interface PassTotal {
	pass: number;
	total: number;
}

export interface SavedFile {
	/** File id, for example `api-tests--sql-test` or `synthetic--do-sql-test`. */
	id: string;
	area: string;
	synthetic: boolean;
	pass: number;
	/** Scored tests. Infra-excluded and workerd-only tests are not in the total. */
	total: number;
	infra: number;
	workerdOnly: number;
}

export interface SavedTest {
	/** File id, the same as `SavedFile.id`. */
	file: string;
	area: string;
	test: string;
	status: SummaryStatus;
	cause: string | null;
	/** First error line without stack frames, at most 200 characters. Absent on passes. */
	error?: string;
	/** Outcome on plain Node.js with stock built-ins. Node.js compat tests only. */
	node?: "pass" | "fail";
	/** Why plain Node.js fails the test, compacted like `error`. */
	nodeError?: string;
	/** For a `quota` row: what Orange did, and the Cloudflare quota the test checks. */
	outcome?: "pass" | "fail";
	quota?: string;
}

export interface RunSnapshot {
	/**
	 * Version 1 snapshots have no plain Node.js outcomes, so all their Node.js tests count. Versions
	 * 1 and 2 have no `/tmp`-remapped tests.
	 */
	schemaVersion: 1 | 2 | typeof resultsSchemaVersion;
	/** UTC date the run started, `YYYY-MM-DD`. */
	date: string;
	startedAt: string;
	/** UTC commit time of `orange.sha`. Saved runs are ordered by it, falling back to `startedAt`. */
	committedAt?: string;
	wallSeconds: number;
	label: string | null;
	note: string | null;
	orange: { sha: string; dirty: boolean | null };
	/** Installed `rivetkit` package version. */
	rivetkit: string;
	/** `binary: null` means RivetKit's bundled `rivet-engine`. */
	engine: { binary: string | null };
	workerd: { tag: string; commit: string };
	/** Dotted field paths whose values were not verified, for example `orange.sha`. */
	unverified: string[];
	totals: {
		files: number;
		syntheticFiles: number;
		/** Scored tests, upstream and synthetic. */
		all: PassTotal;
		upstream: PassTotal;
		synthetic: PassTotal;
		/** Upstream tests outside the Node.js compat area. */
		cloudflare: PassTotal;
		/** Node.js compat tests that pass on plain Node.js. */
		node: PassTotal;
		infraExcluded: number;
		/** Tests that only check a Cloudflare quota, cut from the score. Absent in older runs. */
		cloudflareQuotaCut?: number;
		/** Node.js compat tests that fail on plain Node.js, so they test workerd-specific behavior. */
		workerdOnly: number;
		/**
		 * Tests of files that ran with `/tmp` rewritten to a scratch directory, and that plain Node.js
		 * does not fail. Not scored: `pass` counts `remapped-pass`, `total` adds `remapped-fail`.
		 */
		remapped: PassTotal;
	};
	/** Scored upstream tests only, by area, largest first. */
	perArea: Record<string, PassTotal>;
	/** Failed scored tests by cause, upstream and synthetic, largest first. */
	perCause: Record<string, number>;
	/** File id to the `upstream.json` reason, for files scored as `Not supported`. */
	notSupported: Record<string, string>;
	files: SavedFile[];
	tests: SavedTest[];
}

export interface HistoryEntry {
	/** `run` entries are rebuilt from `runs/`. `manual` entries predate saved runs and are kept as is. */
	source: "run" | "manual";
	date: string;
	label: string | null;
	/** Orange git sha, or null when unknown. */
	sha: string | null;
	rivetkit: string | null;
	/** Upstream tests only, so every entry compares. */
	pass: number;
	total: number;
	synthetic: PassTotal | null;
	/** Upstream tests outside the Node.js compat area. Absent on entries saved before it existed. */
	cloudflare?: PassTotal | null;
	/** Node.js compat tests that pass on plain Node.js. Null for schema 1 runs. */
	node?: PassTotal | null;
	perArea: Record<string, PassTotal> | null;
	/** Path of the run snapshot, relative to `results/`. */
	run?: string;
	note?: string;
	unverified?: string[];
}

/** What `pnpm upstream` writes to `run.json`. Older runs lack `orange` and `rivetkit`. */
interface RunMeta {
	workerd: { tag: string; commit: string };
	files: number;
	filter?: string | null;
	engineBinary: string | null;
	startedAt: string;
	wallSeconds: number;
	orange?: { sha: string | null; dirty: boolean | null };
	rivetkit?: string | null;
}

export interface OrangeBuild {
	orange: { sha: string | null; dirty: boolean | null };
	rivetkit: string | null;
}

/** Reads the Orange commit and the installed RivetKit version, for `run.json`. */
export async function readOrangeBuild(
	repositoryRoot: string,
): Promise<OrangeBuild> {
	let sha: string | null = null;
	let dirty: boolean | null = null;
	try {
		sha = (
			await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
		).stdout.trim();
		dirty =
			(
				await execFileAsync("git", ["status", "--porcelain"], {
					cwd: repositoryRoot,
				})
			).stdout.trim() !== "";
	} catch {
		// Not a git checkout, for example a synced copy. `results:save --orange-sha` fills it in.
	}
	let rivetkit: string | null = null;
	try {
		const manifest = JSON.parse(
			await readFile(
				join(repositoryRoot, "node_modules/rivetkit/package.json"),
				"utf8",
			),
		) as { version?: unknown };
		rivetkit = typeof manifest.version === "string" ? manifest.version : null;
	} catch {
		rivetkit = null;
	}
	return { orange: { sha, dirty }, rivetkit };
}

export interface SaveRunOptions {
	runDirectory: string;
	resultsDirectory: string;
	orangeSha?: string;
	rivetkit?: string;
	label?: string;
	note?: string;
	unverified?: readonly string[];
}

const syntheticPrefix = "synthetic--";

// Errors carry stack frames and host paths. Keep the message only.
// A saved result names repository files from the repository root, never from a developer's machine.
function withoutLocalPaths(text: string): string {
	return text
		.replace(/(?:\/(?:home|Users)\/[^/\s]+|~)\/[^\s"]*?\/(?=(?:packages|src|tests)\/)/g, "")
		.replace(/\/(?:home|Users)\/[^/\s]+\//g, "~/");
}

function compactError(error: string): string {
	return withoutLocalPaths(
		error
			.split(" | ")
			.filter((part) => !/^\s*at /.test(part))
			.join(" | ")
			.replace(/(?:\/tmp|\/var\/folders\/\S*?)\/oo-upstream-[^/\s]+\//g, "")
			.replace(/(?:\/tmp|\/var\/folders\/\S*?)\/oo-fs-scratch-[^/\s]+\/tmp/g, "/tmp"),
	)
		.trim()
		.slice(0, 200);
}

function count(rows: readonly SummaryRow[]): PassTotal {
	return {
		pass: rows.filter((row) => row.status === "pass").length,
		total: rows.length,
	};
}

function byTotal<T>(
	entries: Iterable<[string, T]>,
	size: (value: T) => number,
): Record<string, T> {
	return Object.fromEntries(
		[...entries].sort(
			(a, b) => size(b[1]) - size(a[1]) || a[0].localeCompare(b[0]),
		),
	);
}

function requireValue<T>(value: T | null | undefined, message: string): T {
	if (value === null || value === undefined) throw new Error(message);
	return value;
}

export async function buildRunSnapshot(
	options: SaveRunOptions,
): Promise<RunSnapshot> {
	const { runDirectory } = options;
	const meta = JSON.parse(
		await readFile(join(runDirectory, "run.json"), "utf8"),
	) as RunMeta;
	if (meta.filter !== undefined && meta.filter !== null) {
		throw new Error(
			`${runDirectory} ran only files matching --filter ${meta.filter}. Save a full run.`,
		);
	}
	const rows = JSON.parse(
		await readFile(join(runDirectory, summaryFileName), "utf8"),
	) as SummaryRow[];
	const ids = (await readRunResults(runDirectory)).map((result) => result.id);

	// Summary rows name files without the directory prefix, so map them back by name and area.
	const idByRowKey = new Map<string, string>();
	for (const id of ids) {
		const key = `${fileName(id)}|${areaOf(id)}`;
		if (idByRowKey.has(key)) {
			throw new Error(`Two upstream files map to summary key ${key}`);
		}
		idByRowKey.set(key, id);
	}
	const tests: SavedTest[] = rows.map((row) => {
		const id = idByRowKey.get(`${row.file}|${row.area}`);
		if (id === undefined) {
			throw new Error(
				`summary.json row ${row.file} > ${row.test} has no per-file result in ${runDirectory}`,
			);
		}
		const saved: SavedTest = {
			file: id,
			area: row.area,
			test: row.test,
			status: row.status,
			cause: row.cause === null ? null : withoutLocalPaths(row.cause),
		};
		if (row.status !== "pass" && row.error !== "") {
			saved.error = compactError(row.error);
		}
		if (row.node !== undefined) {
			saved.node = row.node;
		}
		if (row.node === "fail" && row.nodeError) {
			saved.nodeError = compactError(row.nodeError);
		}
		if (row.status === "quota") {
			if (row.outcome !== undefined) saved.outcome = row.outcome;
			if (row.quota !== undefined) saved.quota = row.quota;
		}
		return saved;
	});

	const scored = rows.filter(isScored);
	const upstream = scored.filter((row) => !row.file.startsWith(syntheticPrefix));
	const synthetic = scored.filter((row) => row.file.startsWith(syntheticPrefix));

	const perArea = new Map<string, PassTotal>();
	for (const row of upstream) {
		const area = perArea.get(row.area) ?? { pass: 0, total: 0 };
		area.total += 1;
		if (row.status === "pass") area.pass += 1;
		perArea.set(row.area, area);
	}
	const perCause = new Map<string, number>();
	const notSupported: Record<string, string> = {};
	for (const [index, row] of rows.entries()) {
		if (row.status !== "fail" || !isScored(row)) continue;
		const cause = withoutLocalPaths(row.cause ?? "");
		perCause.set(cause, (perCause.get(cause) ?? 0) + 1);
		const file = tests[index]?.file;
		if (cause === NOT_SUPPORTED_CAUSE && file !== undefined && row.why) {
			notSupported[file] = row.why;
		}
	}

	const files: SavedFile[] = ids.map((id) => {
		const fileTests = tests.filter((test) => test.file === id);
		return {
			id,
			area: areaOf(id),
			synthetic: id.startsWith(syntheticPrefix),
			pass: fileTests.filter(
				(test) => isScored(test) && test.status === "pass",
			).length,
			total: fileTests.filter(isScored).length,
			infra: fileTests.filter((test) => test.status === "infra").length,
			workerdOnly: fileTests.filter(isWorkerdOnly).length,
		};
	});

	const sha = requireValue(
		options.orangeSha ?? meta.orange?.sha,
		`${runDirectory}/run.json has no Orange sha. Pass --orange-sha.`,
	);
	if (!/^[0-9a-f]{7,40}$/.test(sha)) {
		throw new Error(`Orange sha "${sha}" is not a git sha`);
	}
	const committedAt = await commitTime(sha, options.resultsDirectory);
	return {
		schemaVersion: resultsSchemaVersion,
		date: meta.startedAt.slice(0, 10),
		startedAt: meta.startedAt,
		...(committedAt === undefined ? {} : { committedAt }),
		wallSeconds: meta.wallSeconds,
		label: options.label ?? null,
		note: options.note ?? null,
		orange: {
			sha: sha.slice(0, 7),
			dirty: options.orangeSha === undefined ? (meta.orange?.dirty ?? null) : null,
		},
		rivetkit: requireValue(
			options.rivetkit ?? meta.rivetkit,
			`${runDirectory}/run.json has no rivetkit version. Pass --rivetkit.`,
		),
		engine: { binary: meta.engineBinary },
		workerd: meta.workerd,
		unverified: [...(options.unverified ?? [])],
		totals: {
			files: ids.length,
			syntheticFiles: files.filter((file) => file.synthetic).length,
			all: count(scored),
			upstream: count(upstream),
			synthetic: count(synthetic),
			cloudflare: count(upstream.filter((row) => row.area !== NODE_AREA)),
			node: count(upstream.filter((row) => row.area === NODE_AREA)),
			infraExcluded: rows.filter((row) => row.status === "infra").length,
			cloudflareQuotaCut: rows.filter((row) => row.status === "quota").length,
			workerdOnly: rows.filter(isWorkerdOnly).length,
			remapped: {
				pass: rows.filter(
					(row) => isRemapped(row) && row.status === "remapped-pass",
				).length,
				total: rows.filter(isRemapped).length,
			},
		},
		perArea: byTotal(perArea, (value) => value.total),
		perCause: byTotal(perCause, (value) => value),
		notSupported,
		files,
		tests,
	};
}

// One file or test row per line keeps the committed JSON diffable.
function formatSnapshot(snapshot: RunSnapshot): string {
	const rowArray = (rows: readonly unknown[]) =>
		`[\n\t\t${rows.map((row) => JSON.stringify(row)).join(",\n\t\t")}\n\t]`;
	return `${JSON.stringify(
		{ ...snapshot, files: "@files", tests: "@tests" },
		null,
		"\t",
	)
		.replace('"@files"', () => rowArray(snapshot.files))
		.replace('"@tests"', () => rowArray(snapshot.tests))}\n`;
}

function historyEntry(snapshot: RunSnapshot, run: string): HistoryEntry {
	return {
		source: "run",
		date: snapshot.date,
		label: snapshot.label,
		sha: snapshot.orange.sha,
		rivetkit: snapshot.rivetkit,
		pass: snapshot.totals.upstream.pass,
		total: snapshot.totals.upstream.total,
		synthetic:
			snapshot.totals.syntheticFiles > 0 ? snapshot.totals.synthetic : null,
		cloudflare: snapshot.totals.cloudflare,
		node: snapshot.schemaVersion === 1 ? null : snapshot.totals.node,
		perArea: snapshot.perArea,
		run,
		...(snapshot.note === null ? {} : { note: snapshot.note }),
		...(snapshot.unverified.length === 0
			? {}
			: { unverified: snapshot.unverified }),
	};
}

export async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

/** The UTC commit time of `sha`, or undefined when the checkout does not have the commit. */
async function commitTime(sha: string, cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["show", "-s", "--format=%cI", sha], { cwd });
		return new Date(stdout.trim()).toISOString();
	} catch {
		return undefined;
	}
}

/** The time that orders saved runs: the commit time, or the start time for runs without one. */
export function runOrder(snapshot: Pick<RunSnapshot, "committedAt" | "startedAt">): string {
	return snapshot.committedAt ?? snapshot.startedAt;
}

type SnapshotV1 = Omit<RunSnapshot, "totals" | "files"> & {
	schemaVersion: 1;
	totals: Omit<
		RunSnapshot["totals"],
		"cloudflare" | "node" | "workerdOnly" | "remapped"
	>;
	files: Array<Omit<SavedFile, "workerdOnly">>;
};
type SnapshotV2 = Omit<RunSnapshot, "totals"> & {
	schemaVersion: 2;
	totals: Omit<RunSnapshot["totals"], "remapped">;
};

/**
 * Reads a saved run. Schema 1 runs get the schema 2 totals, with every Node.js test counted.
 * Schema 1 and 2 runs get no remapped tests.
 */
export async function readRunSnapshot(path: string): Promise<RunSnapshot> {
	const snapshot = await readJson<RunSnapshot | SnapshotV2 | SnapshotV1>(path);
	if (snapshot.schemaVersion === resultsSchemaVersion) {
		return snapshot;
	}
	if (snapshot.schemaVersion === 2) {
		return {
			...snapshot,
			totals: { ...snapshot.totals, remapped: { pass: 0, total: 0 } },
		};
	}
	const node = snapshot.perArea[NODE_AREA] ?? { pass: 0, total: 0 };
	const { upstream } = snapshot.totals;
	return {
		...snapshot,
		totals: {
			...snapshot.totals,
			cloudflare: {
				pass: upstream.pass - node.pass,
				total: upstream.total - node.total,
			},
			node,
			workerdOnly: 0,
			remapped: { pass: 0, total: 0 },
		},
		files: snapshot.files.map((file) => ({ ...file, workerdOnly: 0 })),
	};
}

/** Path of a run snapshot relative to `results/`, as `history.json` records it. */
export function savedRunPath(snapshot: Pick<RunSnapshot, "date" | "orange">): string {
	return `runs/${snapshot.date}-${snapshot.orange.sha}.json`;
}

/**
 * Writes `runs/<date>-<sha7>.json`, then rebuilds `latest.json` and the `run` entries of
 * `history.json` from every saved run. Re-saving the same run replaces its snapshot.
 */
export async function saveRun(
	options: SaveRunOptions,
): Promise<{ path: string; snapshot: RunSnapshot }> {
	const snapshot = await buildRunSnapshot(options);
	const runsDirectory = join(options.resultsDirectory, "runs");
	await mkdir(runsDirectory, { recursive: true });
	const path = join(options.resultsDirectory, savedRunPath(snapshot));
	if (existsSync(path)) {
		const existing = await readRunSnapshot(path);
		if (existing.startedAt !== snapshot.startedAt) {
			throw new Error(
				`${path} already holds the run that started at ${existing.startedAt}`,
			);
		}
	}
	await writeFile(path, formatSnapshot(snapshot));

	const saved: Array<{ name: string; snapshot: RunSnapshot }> = [];
	for (const file of (await readdir(runsDirectory)).filter((file) =>
		file.endsWith(".json"),
	)) {
		saved.push({
			name: file,
			snapshot: await readRunSnapshot(join(runsDirectory, file)),
		});
	}
	saved.sort((a, b) => runOrder(a.snapshot).localeCompare(runOrder(b.snapshot)));
	const newest = saved.at(-1);
	if (newest !== undefined) {
		await writeFile(
			join(options.resultsDirectory, "latest.json"),
			formatSnapshot(newest.snapshot),
		);
	}

	const historyPath = join(options.resultsDirectory, "history.json");
	const manual = existsSync(historyPath)
		? (await readJson<HistoryEntry[]>(historyPath)).filter(
				(entry) => entry.source === "manual",
			)
		: [];
	const history = [
		...manual.map((entry) => ({ entry, order: entry.date })),
		...saved.map(({ name, snapshot }) => ({
			entry: historyEntry(snapshot, `runs/${name}`),
			order: runOrder(snapshot),
		})),
	]
		.sort((a, b) => a.order.localeCompare(b.order))
		.map(({ entry }) => entry);
	await writeFile(historyPath, `${JSON.stringify(history, null, "\t")}\n`);
	return { path, snapshot };
}
