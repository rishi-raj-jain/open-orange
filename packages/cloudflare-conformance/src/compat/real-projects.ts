import { readFile } from "node:fs/promises";

/**
 * Result of one real project in one run mode, compared with `wrangler dev`.
 * - `works`: every tested flow behaves like `wrangler dev`.
 * - `partial`: it starts, and some flows break.
 * - `fails`: it does not run.
 * - `needs-step`: it needs a step that this run mode does not include, so it does not start.
 */
export const realProjectStatuses = [
	"works",
	"partial",
	"fails",
	"needs-step",
] as const;
export type RealProjectStatus = (typeof realProjectStatuses)[number];

/**
 * - `unchanged`: config unchanged, plus `d1 migrations apply`.
 * - `build`: `unchanged` plus the project's own build step.
 * - `probe`: `build` plus a one-key probe config.
 */
export const realProjectModes = ["unchanged", "build", "probe"] as const;
export type RealProjectMode = (typeof realProjectModes)[number];

export type RealProjectResults = Record<RealProjectMode, RealProjectStatus>;

export interface RealProject {
	project: string;
	/** Source tree at the tested commit. */
	url: string;
	/** Flows that the run exercised. */
	flows: string;
	before: RealProjectResults;
	after: RealProjectResults;
	/** Why the project does not work in every mode. Present exactly when an `after` result is not `works`. */
	blocker?: string;
}

export interface RealProjectRun {
	/** YYYY-MM-DD */
	date: string;
	/** Short Orange commit SHA. */
	orange: string;
}

export interface RealProjectTable {
	schemaVersion: 1;
	before: RealProjectRun;
	after: RealProjectRun;
	/** Wrangler version of the `wrangler dev` baseline. */
	wrangler: string;
	projects: RealProject[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function runProblems(name: string, value: unknown): string[] {
	if (!isRecord(value)) return [`${name} must be an object with date and orange`];
	const problems: string[] = [];
	if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
		problems.push(`${name}.date must be YYYY-MM-DD`);
	}
	if (!nonEmptyString(value.orange)) problems.push(`${name}.orange must be a non-empty string`);
	return problems;
}

/** Parses `compat/real-projects.json` and lists every problem. */
export function validateRealProjectTable(value: unknown): {
	table: RealProjectTable;
	problems: string[];
} {
	if (!isRecord(value) || value.schemaVersion !== 1) {
		return {
			table: {
				schemaVersion: 1,
				before: { date: "", orange: "" },
				after: { date: "", orange: "" },
				wrangler: "",
				projects: [],
			},
			problems: ["real projects must be an object with schemaVersion 1"],
		};
	}
	const problems = [
		...runProblems("before", value.before),
		...runProblems("after", value.after),
	];
	if (!nonEmptyString(value.wrangler)) problems.push("wrangler must be a non-empty string");
	const projects = Array.isArray(value.projects) ? value.projects : [];
	if (projects.length === 0) problems.push("projects has no entries");
	const seen = new Set<string>();
	for (const [index, entry] of projects.entries()) {
		const where = isRecord(entry) && nonEmptyString(entry.project) ? entry.project : `#${index}`;
		if (!isRecord(entry)) {
			problems.push(`${where}: not an object`);
			continue;
		}
		for (const field of ["project", "url", "flows"] as const) {
			if (!nonEmptyString(entry[field])) {
				problems.push(`${where}: ${field} must be a non-empty string`);
			}
		}
		if (nonEmptyString(entry.project)) {
			if (seen.has(entry.project)) problems.push(`${where}: duplicate project`);
			seen.add(entry.project);
		}
		if (nonEmptyString(entry.url) && !entry.url.startsWith("https://")) {
			problems.push(`${where}: url must start with https://`);
		}
		let allWork = true;
		for (const run of ["before", "after"] as const) {
			const results = entry[run];
			if (!isRecord(results)) {
				problems.push(`${where}: ${run} must map ${realProjectModes.join(", ")} to a status`);
				allWork = false;
				continue;
			}
			for (const mode of realProjectModes) {
				if (!(realProjectStatuses as readonly unknown[]).includes(results[mode])) {
					problems.push(
						`${where}: ${run}.${mode} has unknown status ${String(results[mode])} (expected one of ${realProjectStatuses.join(", ")})`,
					);
				}
				if (run === "after" && results[mode] !== "works") allWork = false;
			}
		}
		if (allWork && entry.blocker !== undefined) {
			problems.push(`${where}: blocker is set, but every after result is works`);
		}
		if (!allWork && !nonEmptyString(entry.blocker)) {
			problems.push(`${where}: blocker must say why an after result is not works`);
		}
	}
	return { table: value as unknown as RealProjectTable, problems };
}

export async function readRealProjectTable(path: string): Promise<RealProjectTable> {
	const { table, problems } = validateRealProjectTable(
		JSON.parse(await readFile(path, "utf8")),
	);
	if (problems.length > 0) {
		throw new Error(`${path} is invalid:\n  ${problems.join("\n  ")}`);
	}
	return table;
}
