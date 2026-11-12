import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { readCorpus, type CorpusProject } from "../real-projects/corpus.js";
import type { RealProjectResult } from "../real-projects/result.js";
import { runProject, stopEverything } from "../real-projects/run-project.js";
import type { Scenario } from "../real-projects/scenario.js";
import { packageRoot } from "./generate.js";

export const realProjectsUsage = `Usage: cloudflare-conformance real-projects [--probes] [--filter <regex>] [--jobs <n>] [--scratch <dir>] [--keep] [--sleep-gate emulated]

Clones each project in real-projects/<id>/project.json at its pinned commit, installs it with install scripts off, runs its build, starts orange dev on it, and runs its scenario. Each result goes to real-projects/<id>/result.json.

Run this on a disposable machine. It runs third-party code.

Options:
  --probes                Run probes/ instead: each runs on orange dev (result.json) and, when it asks, on wrangler dev (baseline.json)
  --filter <regex>        Only ids that match
  --jobs <n>              Projects to run at once (default 4)
  --scratch <dir>         Clones and logs (default .real-projects/, gitignored)
  --keep                  Keep each clone and its node_modules for the next run
  --sleep-gate emulated   Also count an object that Orange soft-hibernated as asleep, although its Rivet actor still runs. The result goes to result.emulated.json, and result.json stays as it is`;

interface RealProjectsIo {
	log(message: string): void;
}

export const realProjectsDirectory = join(packageRoot, "real-projects");
export const probesDirectory = join(packageRoot, "probes");

function orangeIdentity(root: string): { sha: string; dirty: boolean | null } {
	const fromEnvironment = process.env.ORANGE_SHA;
	if (fromEnvironment !== undefined && fromEnvironment !== "") return { sha: fromEnvironment, dirty: null };
	const sha = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
	return { sha, dirty: status !== "" };
}

async function loadScenario(root: string, project: CorpusProject): Promise<Scenario | undefined> {
	const path = join(root, project.id, "scenario.ts");
	if (!existsSync(path)) return undefined;
	const module = (await import(pathToFileURL(path).href)) as { default: Scenario };
	return module.default;
}

export async function realProjects(args: readonly string[], io: RealProjectsIo): Promise<void> {
	const { values } = parseArgs({
		args: [...args],
		options: {
			filter: { type: "string" },
			jobs: { type: "string", default: "4" },
			scratch: { type: "string" },
			keep: { type: "boolean", default: false },
			probes: { type: "boolean", default: false },
			"sleep-gate": { type: "string", default: "strict" },
		},
		strict: true,
		allowPositionals: false,
	});
	const sleepGate = values["sleep-gate"];
	if (sleepGate !== "strict" && sleepGate !== "emulated") throw new Error(`--sleep-gate takes strict or emulated, not ${sleepGate}`);
	if (sleepGate === "emulated" && values.probes === true) throw new Error("--sleep-gate emulated runs real projects, not probes");
	const emulated = sleepGate === "emulated";
	const filter = values.filter === undefined ? undefined : new RegExp(values.filter);
	const root = values.probes === true ? probesDirectory : realProjectsDirectory;
	const queue = await readCorpus(root, filter);
	if (queue.length === 0) throw new Error(`No project matches ${values.filter}`);
	const scratch = resolve(values.scratch ?? join(packageRoot, ".real-projects"));
	await mkdir(scratch, { recursive: true });
	const orangeRoot = join(packageRoot, "../..");
	const orange = orangeIdentity(orangeRoot);
	const rivetkit = (
		JSON.parse(readFileSync(join(orangeRoot, "packages/runtime-node/package.json"), "utf8")) as {
			dependencies: Record<string, string>;
		}
	).dependencies.rivetkit ?? "unknown";

	const stopSignal = () => {
		void stopEverything().finally(() => process.exit(130));
	};
	process.once("SIGINT", stopSignal);
	process.once("SIGTERM", stopSignal);

	const summary: RealProjectResult[] = [];
	await Promise.all(
		Array.from({ length: Number(values.jobs) }, async () => {
			for (let project = queue.shift(); project !== undefined; project = queue.shift()) {
				const common = {
					project,
					scenario: await loadScenario(root, project),
					orangeRoot,
					orange,
					rivetkit,
					scratch,
					projectDirectory: join(root, project.id),
					keep: values.keep ?? false,
					log: io.log,
				};
				const result = await runProject({ ...common, baseline: false, sleepGate });
				const file = emulated ? "result.emulated.json" : "result.json";
				await writeFile(join(root, project.id, file), `${JSON.stringify(result, null, "\t")}\n`);
				if (project.baseline === true && !emulated) {
					const baseline = await runProject({ ...common, baseline: true });
					await writeFile(join(root, project.id, "baseline.json"), `${JSON.stringify(baseline, null, "\t")}\n`);
				}
				summary.push(result);
				const failed = result.steps.filter((step) => step.status === "fail").map((step) => step.name);
				io.log(`${project.id}${emulated ? " (emulated sleep gate)" : ""}: ${result.status}${failed.length > 0 ? ` (failed: ${failed.join(", ")})` : ""}`);
			}
		}),
	);
	await rm(join(scratch, ".tmp"), { force: true, recursive: true });
	const counts = new Map<string, number>();
	for (const result of summary) counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
	io.log([...counts].map(([status, count]) => `${status}: ${count}`).join(" · "));
	// A scenario can leave a socket or a project's module handle open, so the process must end here.
	process.exit(0);
}
