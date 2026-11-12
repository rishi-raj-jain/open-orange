import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const compatCategories = [
	"bindings",
	"handlers",
	"runtime-apis",
	"node-compat",
	"fetch",
	"durable-objects",
	"durable-object-storage",
	"sql",
	"compat-flags",
	"config",
	"limits",
] as const;
export type CompatCategory = (typeof compatCategories)[number];

/**
 * - `supported`: works like Cloudflare.
 * - `partial`: works, with listed differences.
 * - `alternative`: the API works on an Orange backend, such as KV and D1 on Rivet Actors.
 * - `stub`: the API exists and throws a clear error.
 * - `rejected`: config load or Worker load fails with a clear error.
 * - `unsupported`: missing, ignored, or wrong without a clear error.
 * - `not-applicable`: a deploy-only setting, or a workerd-only or experimental feature that
 *   Cloudflare does not deploy.
 */
export const compatStatuses = [
	"supported",
	"partial",
	"alternative",
	"stub",
	"rejected",
	"unsupported",
	"not-applicable",
] as const;
export type CompatStatus = (typeof compatStatuses)[number];

export type CompatEvidence =
	/** Repository-relative source path, with optional `12` or `12-20` lines. */
	| { kind: "code"; path: string; lines?: string }
	/** A test in the saved results, by file id and test name. */
	| { kind: "test"; file: string; test: string }
	| { kind: "doc"; url: string }
	/** A research note outside the repository. Readable only on the author's machine. */
	| { kind: "note"; path: string };

export interface CompatEntry {
	id: string;
	category: CompatCategory;
	name: string;
	status: CompatStatus;
	cloudflare: string;
	orange: string;
	notes: string;
	evidence: CompatEvidence[];
	workaround?: string;
	since?: string;
	/** What is not verified about this entry. Absent when every claim is verified. */
	unverified?: string;
}

export interface CompatMatrix {
	schemaVersion: 1;
	entries: CompatEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function evidenceProblem(
	evidence: unknown,
	repositoryRoot: string,
	testIds: ReadonlySet<string> | undefined,
): string | undefined {
	if (!isRecord(evidence)) return "is not an object";
	switch (evidence.kind) {
		case "code": {
			if (!nonEmptyString(evidence.path)) return "has no path";
			if (!existsSync(join(repositoryRoot, evidence.path))) {
				return `names missing file ${evidence.path}`;
			}
			if (evidence.lines === undefined) return undefined;
			const range = /^(\d+)(?:-(\d+))?$/.exec(String(evidence.lines));
			if (range === null) return `has invalid lines ${String(evidence.lines)}`;
			const first = Number(range[1]);
			const last = Number(range[2] ?? range[1]);
			const lineCount = readFileSync(
				join(repositoryRoot, evidence.path),
				"utf8",
			).split("\n").length;
			if (first < 1 || last < first || last > lineCount) {
				return `names lines ${String(evidence.lines)} outside ${evidence.path} (${lineCount} lines)`;
			}
			return undefined;
		}
		case "test":
			if (!nonEmptyString(evidence.file) || !nonEmptyString(evidence.test)) {
				return "needs file and test";
			}
			if (
				testIds !== undefined &&
				!testIds.has(`${evidence.file} > ${evidence.test}`)
			) {
				return `names ${evidence.file} > ${evidence.test}, which is not in the saved results`;
			}
			return undefined;
		case "doc":
			return nonEmptyString(evidence.url) &&
				evidence.url.startsWith("https://")
				? undefined
				: "needs an https url";
		case "note":
			return nonEmptyString(evidence.path) ? undefined : "has no path";
		default:
			return `has unknown kind ${String(evidence.kind)}`;
	}
}

/**
 * Parses `compat/matrix.json` and lists every problem. Code evidence must name a file in the
 * repository, and its lines must exist in that file. Test evidence must name a test in
 * `testIds` when given.
 */
export function validateCompatMatrix(
	value: unknown,
	repositoryRoot: string,
	testIds?: ReadonlySet<string>,
): { matrix: CompatMatrix; problems: string[] } {
	const problems: string[] = [];
	if (!isRecord(value) || value.schemaVersion !== 1) {
		return {
			matrix: { schemaVersion: 1, entries: [] },
			problems: ["matrix must be an object with schemaVersion 1"],
		};
	}
	const entries = Array.isArray(value.entries) ? value.entries : [];
	if (entries.length === 0) problems.push("matrix has no entries");
	const ids = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		const where = isRecord(entry) && nonEmptyString(entry.id) ? entry.id : `#${index}`;
		if (!isRecord(entry)) {
			problems.push(`${where}: not an object`);
			continue;
		}
		if (!nonEmptyString(entry.id) || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) {
			problems.push(`${where}: id must be kebab-case`);
		} else if (ids.has(entry.id)) {
			problems.push(`${where}: duplicate id`);
		} else {
			ids.add(entry.id);
		}
		if (!(compatCategories as readonly unknown[]).includes(entry.category)) {
			problems.push(`${where}: unknown category ${String(entry.category)}`);
		}
		if (!(compatStatuses as readonly unknown[]).includes(entry.status)) {
			problems.push(`${where}: unknown status ${String(entry.status)}`);
		}
		for (const field of ["name", "cloudflare", "orange", "notes"] as const) {
			if (!nonEmptyString(entry[field])) {
				problems.push(`${where}: ${field} must be a non-empty string`);
			}
		}
		for (const field of ["workaround", "since", "unverified"] as const) {
			if (entry[field] !== undefined && !nonEmptyString(entry[field])) {
				problems.push(`${where}: ${field} must be a non-empty string when set`);
			}
		}
		const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
		if (evidence.length === 0) problems.push(`${where}: evidence is empty`);
		for (const item of evidence) {
			const problem = evidenceProblem(item, repositoryRoot, testIds);
			if (problem !== undefined) {
				problems.push(`${where}: evidence ${problem}`);
			}
		}
	}
	return { matrix: value as unknown as CompatMatrix, problems };
}

export async function readCompatMatrix(
	path: string,
	repositoryRoot: string,
	testIds?: ReadonlySet<string>,
): Promise<CompatMatrix> {
	const { matrix, problems } = validateCompatMatrix(
		JSON.parse(await readFile(path, "utf8")),
		repositoryRoot,
		testIds,
	);
	if (problems.length > 0) {
		throw new Error(`${path} is invalid:\n  ${problems.join("\n  ")}`);
	}
	return matrix;
}
