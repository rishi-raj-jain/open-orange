import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CorpusProject } from "../real-projects/corpus.js";
import type { RealProjectResult } from "../real-projects/result.js";
import { readRunSnapshot } from "../results/save.js";
import {
	buildTruthTable,
	type CloudRun,
	type ExampleResults,
	type ProjectRun,
	type ReproResult,
	type TruthTableInputs,
} from "../truth-table/build.js";
import type { TruthTable, TruthTableSource } from "../truth-table/types.js";
import { packageRoot } from "./generate.js";
import { probesDirectory, realProjectsDirectory } from "./real-projects.js";

export const truthTableUsage = `Usage: cloudflare-conformance truth-table

Builds compat/truth-table.json from results/latest.json, results/runnable-examples.json, probes/*/result.json, real-projects/*/result.json, real-projects/*/result.emulated.json, and the text in compat/truth-table.claims.json. Stops when a claim's text no longer matches its results.`;

export const truthTablePath = join(packageRoot, "compat/truth-table.json");
const claimsPath = join(packageRoot, "compat/truth-table.claims.json");
const examplesPath = join(packageRoot, "results/runnable-examples.json");
const excludedPath = join(realProjectsDirectory, "excluded.json");
const reprosDirectory = join(packageRoot, "repros");

async function readJsonFile<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

async function projectDirectories(root: string): Promise<string[]> {
	return (await readdir(root, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

export async function readTruthTableInputs(): Promise<TruthTableInputs> {
	const probes = new Map<string, { result: RealProjectResult; baseline?: RealProjectResult }>();
	for (const id of await projectDirectories(probesDirectory)) {
		const path = join(probesDirectory, id, "result.json");
		if (!existsSync(path)) continue;
		const baselinePath = join(probesDirectory, id, "baseline.json");
		probes.set(id, {
			result: await readJsonFile<RealProjectResult>(path),
			...(existsSync(baselinePath) ? { baseline: await readJsonFile<RealProjectResult>(baselinePath) } : {}),
		});
	}
	const projects: ProjectRun[] = [];
	for (const id of await projectDirectories(realProjectsDirectory)) {
		const path = join(realProjectsDirectory, id, "result.json");
		if (!existsSync(path)) continue;
		// Who owns a failure is an opinion about the run, not part of it, so it comes from the current project.json.
		const project = await readJsonFile<CorpusProject>(join(realProjectsDirectory, id, "project.json"));
		const emulatedPath = join(realProjectsDirectory, id, "result.emulated.json");
		projects.push({
			...(await readJsonFile<RealProjectResult>(path)),
			knownFailures: project.knownFailures ?? [],
			...(existsSync(emulatedPath) ? { emulated: await readJsonFile<RealProjectResult>(emulatedPath) } : {}),
		});
	}
	const cloud = new Map<string, CloudRun>();
	for (const id of await projectDirectories(realProjectsDirectory)) {
		const path = join(realProjectsDirectory, id, "cloud-result.json");
		if (existsSync(path)) cloud.set(id, await readJsonFile<CloudRun>(path));
	}
	const repros = new Map<string, ReproResult>();
	if (existsSync(reprosDirectory)) {
		for (const id of await projectDirectories(reprosDirectory)) {
			const path = join(reprosDirectory, id, "result.json");
			if (existsSync(path)) repros.set(id, await readJsonFile<ReproResult>(path));
		}
	}
	return {
		source: await readJsonFile<TruthTableSource>(claimsPath),
		conformance: await readRunSnapshot(join(packageRoot, "results/latest.json")),
		probes,
		projects,
		cloud,
		examples: existsSync(examplesPath) ? await readJsonFile<ExampleResults>(examplesPath) : null,
		repros,
		excluded: existsSync(excludedPath) ? await readJsonFile(excludedPath) : [],
	};
}

export async function readTruthTable(): Promise<TruthTable> {
	return await readJsonFile<TruthTable>(truthTablePath);
}

export async function truthTable(io: { log(message: string): void }): Promise<void> {
	const { table, stale } = buildTruthTable(await readTruthTableInputs());
	if (stale.length > 0) {
		throw new Error(`Rewrite these claims in compat/truth-table.claims.json:\n  ${stale.join("\n  ")}`);
	}
	await writeFile(truthTablePath, `${JSON.stringify(table, null, "\t")}\n`);
	io.log(`wrote ${truthTablePath}`);
	io.log(`claims: ${JSON.stringify(table.summary.claims)}`);
	io.log(`projects: ${JSON.stringify(table.summary.projects)}, unmodified ${table.summary.unmodified}`);
	io.log(`emulated hibernation steps, still failed above: ${JSON.stringify(table.emulatedHibernation.steps)}`);
}
