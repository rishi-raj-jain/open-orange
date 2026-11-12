import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	isScored,
	isWorkerdOnly,
	NODE_AREA,
	type SummaryRow,
	summarizeResults,
} from "./classify.js";
import type { UpstreamFileResult } from "./run-file.js";

export const summaryFileName = "summary.json";

/** Per-file results of a run directory, from this command or the original harness. */
export async function readRunResults(
	directory: string,
): Promise<UpstreamFileResult[]> {
	// Per-file results are named by file id, for example `api-tests--actor-kv-test.json`.
	const names = (await readdir(directory))
		.filter((name) => /^[\w-]+--.+\.json$/.test(name))
		.sort();
	if (names.length === 0) {
		throw new Error(`${directory} has no per-file upstream results`);
	}
	return Promise.all(
		names.map(
			async (name) =>
				JSON.parse(
					await readFile(join(directory, name), "utf8"),
				) as UpstreamFileResult,
		),
	);
}

function tally(
	rows: readonly SummaryRow[],
	key: (row: SummaryRow) => string,
): Array<[string, { pass: number; total: number }]> {
	const counts = new Map<string, { pass: number; total: number }>();
	for (const row of rows) {
		const count = counts.get(key(row)) ?? { pass: 0, total: 0 };
		count.total += 1;
		if (row.status === "pass") count.pass += 1;
		counts.set(key(row), count);
	}
	return [...counts].sort((a, b) => b[1].total - a[1].total);
}

export function formatSummary(
	fileCount: number,
	rows: readonly SummaryRow[],
): string {
	const scored = rows.filter(isScored);
	const score = (subset: readonly SummaryRow[]) => {
		const pass = subset.filter((row) => row.status === "pass").length;
		const percent =
			subset.length === 0 ? "0.0" : ((pass / subset.length) * 100).toFixed(1);
		return `${pass}/${subset.length} (${percent}%)`;
	};
	const workerdOnly = rows.filter(isWorkerdOnly).length;
	const lines = [
		`files ${fileCount}  pass ${score(scored)}  infra-excluded ${rows.filter((row) => row.status === "infra").length}  workerd-only ${workerdOnly}  cloudflare-quota-cut ${rows.filter((row) => row.status === "quota").length}`,
		"",
		`cloudflare apis  ${score(scored.filter((row) => row.area !== NODE_AREA))}`,
		`node.js          ${score(scored.filter((row) => row.area === NODE_AREA))}  (only tests that pass on plain Node.js)`,
		"",
		"by area",
		...tally(scored, (row) => row.area).map(
			([area, count]) => `  ${area.padEnd(22)} ${count.pass}/${count.total}`,
		),
		"",
		"failures by cause",
		...tally(
			scored.filter((row) => row.status === "fail"),
			(row) => row.cause ?? "",
		).map(([cause, count]) => `  ${String(count.total).padStart(4)}  ${cause}`),
	];
	return lines.join("\n");
}

export interface RunComparison {
	newlyPassing: SummaryRow[];
	/** Tests that passed before and now fail, are infra-excluded, or no longer run. */
	newlyFailing: Array<{ before: SummaryRow; after?: SummaryRow }>;
}

const rowKey = (row: SummaryRow) => `${row.area}|${row.file}|${row.test}`;

export function compareRuns(
	before: readonly SummaryRow[],
	after: readonly SummaryRow[],
): RunComparison {
	const beforeByKey = new Map(before.map((row) => [rowKey(row), row]));
	const afterByKey = new Map(after.map((row) => [rowKey(row), row]));
	return {
		newlyPassing: after.filter(
			(row) =>
				row.status === "pass" &&
				beforeByKey.get(rowKey(row))?.status !== "pass",
		),
		newlyFailing: before
			.filter(
				(row) =>
					row.status === "pass" &&
					afterByKey.get(rowKey(row))?.status !== "pass",
			)
			.map((row) => {
				const afterRow = afterByKey.get(rowKey(row));
				return afterRow === undefined
					? { before: row }
					: { before: row, after: afterRow };
			}),
	};
}

/** Compares only the files that ran this time, so a filtered run does not report every other file. */
export async function compareWithRunDirectory(
	beforeDirectory: string,
	after: readonly UpstreamFileResult[],
): Promise<RunComparison> {
	const ran = new Set(after.map((result) => result.id));
	const before = (await readRunResults(beforeDirectory)).filter((result) =>
		ran.has(result.id),
	);
	return compareRuns(summarizeResults(before), summarizeResults(after));
}

export function formatComparison(comparison: RunComparison): string {
	const name = (row: SummaryRow) => `${row.file} > ${row.test}`;
	return [
		`newly passing ${comparison.newlyPassing.length}`,
		...comparison.newlyPassing.map((row) => `  + ${name(row)}`),
		`newly failing ${comparison.newlyFailing.length}`,
		...comparison.newlyFailing.map(({ before, after }) =>
			after === undefined
				? `  - ${name(before)}  [not run]`
				: `  - ${name(before)}  [${after.cause}]${after.node === "fail" ? " [workerd-only]" : ""} ${after.error.slice(0, 160)}`,
		),
	].join("\n");
}
