import type { KnownFailure } from "../real-projects/corpus.js";
import type { RealProjectResult } from "../real-projects/result.js";
import { deriveStatus } from "../real-projects/result.js";
import type { StepResult } from "../real-projects/scenario.js";
import type { RunSnapshot } from "../results/save.js";
import {
	claimStatuses,
	type Claim,
	type ClaimSource,
	type ClaimStatus,
	type CloudCounts,
	type CloudRow,
	type CloudRunSource,
	type CloudStepStatus,
	type Evidence,
	type EvidenceResult,
	type ProjectFailure,
	type ProjectRow,
	type ProjectStatus,
	projectStatuses,
	type TruthTable,
	type TruthTableSource,
} from "./types.js";

export interface ExampleResults {
	orange: string;
	ranAt: string;
	examples: Record<string, { status: "pass" | "fail"; error?: string }>;
}

/** What a repro with its own setup saved: `repros/<id>/result.json`. */
export interface ReproResult {
	orange: string;
	rivetkit: string;
	ranAt: string;
	steps: StepResult[];
}

/** A run, with the current view of why its steps failed. */
export type ProjectRun = RealProjectResult & {
	knownFailures: readonly KnownFailure[];
	/** The same project under the emulated sleep gate: `real-projects/<id>/result.emulated.json`. */
	emulated?: RealProjectResult;
};

/** What a run on Rivet Cloud saved: `real-projects/<id>/cloud-result.json`. */
export type CloudRun = Omit<CloudRow, "what" | "ran" | "shortfalls" | "counts" | "project"> & { id: string };

export interface TruthTableInputs {
	source: TruthTableSource;
	conformance: RunSnapshot;
	probes: Map<string, { result: RealProjectResult; baseline?: RealProjectResult }>;
	projects: ProjectRun[];
	cloud: Map<string, CloudRun>;
	examples: ExampleResults | null;
	repros: Map<string, ReproResult>;
	excluded: { repo: string; stars: number; reason: string }[];
}

function stepEvidence(
	source: Evidence,
	label: string,
	result: Pick<RealProjectResult, "steps"> | undefined,
	step: string,
	baseline?: RealProjectResult,
): EvidenceResult {
	const found = result?.steps.find((candidate: StepResult) => candidate.name === step);
	if (found === undefined) return { source, label, orange: "not-run" };
	const workerd = baseline?.steps.find((candidate) => candidate.name === step)?.status;
	return {
		source,
		label,
		orange: found.status,
		...(workerd === undefined ? {} : { workerd }),
		...(found.error === undefined ? {} : { error: found.error }),
	};
}

function counted(source: Evidence, label: string, pass: number, total: number, error?: string): EvidenceResult {
	if (total === 0) return { source, label, orange: "not-run" };
	return {
		source,
		label,
		orange: pass === total ? "pass" : pass === 0 ? "fail" : "partial",
		counts: { pass, total },
		...(pass === total || error === undefined ? {} : { error }),
	};
}

function resolveEvidence(evidence: Evidence, inputs: TruthTableInputs): EvidenceResult {
	const { conformance } = inputs;
	const failure = (tests: RunSnapshot["tests"]) => tests.find((test) => test.status === "fail")?.error;
	switch (evidence.kind) {
		case "test": {
			const found = conformance.tests.find((test) => `${test.file} > ${test.test}` === evidence.test);
			if (found === undefined) return { source: evidence, label: evidence.test, orange: "not-run" };
			return {
				source: evidence,
				label: evidence.test,
				orange: found.status === "pass" ? "pass" : "fail",
				...(found.error === undefined ? {} : { error: found.error }),
			};
		}
		case "test-file": {
			const file = conformance.files.find((candidate) => candidate.id === evidence.file);
			const tests = conformance.tests.filter((test) => test.file === evidence.file);
			return counted(evidence, evidence.file, file?.pass ?? 0, file?.total ?? 0, failure(tests));
		}
		case "area": {
			const area = conformance.perArea[evidence.area];
			return counted(evidence, `workerd tests: ${evidence.area}`, area?.pass ?? 0, area?.total ?? 0);
		}
		case "probe": {
			const probe = inputs.probes.get(evidence.probe);
			return stepEvidence(evidence, `${evidence.probe}: ${evidence.step}`, probe?.result, evidence.step, probe?.baseline);
		}
		case "project": {
			const project = inputs.projects.find((candidate) => candidate.id === evidence.project);
			return stepEvidence(evidence, `${evidence.project}: ${evidence.step}`, project, evidence.step);
		}
		case "repro": {
			const repro = inputs.repros.get(evidence.repro);
			return stepEvidence(evidence, `${evidence.repro}: ${evidence.step}`, repro, evidence.step);
		}
		case "example": {
			const example = inputs.examples?.examples[evidence.example];
			if (example === undefined) return { source: evidence, label: `example: ${evidence.example}`, orange: "not-run" };
			return {
				source: evidence,
				label: `example: ${evidence.example}`,
				orange: example.status,
				...(example.error === undefined ? {} : { error: example.error }),
			};
		}
	}
}

/** All evidence passed, some did, none did, or nothing was recorded. */
export function claimStatus(evidence: readonly EvidenceResult[]): ClaimStatus {
	const ran = evidence.filter((item) => item.orange !== "not-run" && item.orange !== "needs-secrets");
	if (ran.length === 0) return "not-run";
	if (ran.every((item) => item.orange === "pass")) return "works";
	if (ran.every((item) => item.orange === "fail")) return "does-not-work";
	return "partial";
}

function toClaim(source: ClaimSource, inputs: TruthTableInputs, stale: string[]): Claim {
	const { writtenFor, evidence: written, ...rest } = source;
	const evidence = written.map((item) => resolveEvidence(item, inputs));
	const status = claimStatus(evidence);
	if (status !== writtenFor) {
		stale.push(`${source.id}: the text describes ${writtenFor}, and the results say ${status}`);
	}
	return { ...rest, status, evidence };
}

const notLookedAt = "Not yet looked at";
const hibernationOwner = "hibernation-not-available";
const ownerLabels: Record<string, string> = {
	orange: "Orange bug",
	rivetkit: "RivetKit bug",
	"hibernation-not-available": "WebSocket hibernation not available on Rivet 3",
	project: "The project's own code",
	environment: "Test environment",
	unknown: "Cause not found",
};

function projectRow(result: ProjectRun): ProjectRow {
	const failures: ProjectFailure[] = result.steps
		.filter((step) => step.status === "fail")
		.map((step) => {
			const known = result.knownFailures.find((failure) => failure.step === step.name);
			// Only a step that fails for lack of hibernation gets one: the emulated gate changes nothing else.
			const emulated =
				known?.owner === hibernationOwner
					? result.emulated?.steps.find((candidate) => candidate.name === step.name)?.status
					: undefined;
			return {
				step: step.name,
				kind: step.kind,
				error: step.error ?? "",
				ownerLabel: known === undefined ? notLookedAt : (ownerLabels[known.owner] ?? known.owner),
				...(known === undefined ? {} : { owner: known.owner, note: known.note }),
				...(known?.reference === undefined ? {} : { reference: known.reference }),
				...(emulated === "pass" || emulated === "fail" ? { emulated } : {}),
			};
		});
	// What the run would be with every emulated pass counted. Only "works" earns the emulated status.
	const withEmulated = result.steps.map((step) =>
		failures.some((failure) => failure.step === step.name && failure.emulated === "pass") ? { ...step, status: "pass" as const } : step,
	);
	const status: ProjectStatus =
		result.status === "partial" && deriveStatus([result.install, result.build, result.boot], withEmulated) === "works"
			? "works-emulated"
			: result.status;
	const phaseError = [result.install, result.build, result.boot].find((phase) => phase?.ok === false)?.error;
	const error = result.notRun ?? phaseError;
	return {
		id: result.id,
		repo: result.repo,
		// The repository root: a change can add the directory that the project runs from.
		url: `https://github.com/${result.repo}/tree/${result.commit}`,
		commit: result.commit,
		stars: result.stars,
		origin: result.origin,
		directory: result.directory,
		status,
		steps: {
			pass: result.steps.filter((step) => step.status === "pass").length,
			total: result.steps.length,
		},
		changes: result.changes,
		failures,
		secrets: [...new Set(result.steps.flatMap((step) => step.secrets ?? []))].sort(),
		...(error === undefined ? {} : { error }),
		durableObjects: result.durableObjects,
		ranAt: result.ranAt,
		orange: result.orange.sha,
		rivetkit: result.rivetkit,
	};
}

function cloudRow(source: CloudRunSource, inputs: TruthTableInputs, stale: string[]): CloudRow | undefined {
	const { writtenFor, ...text } = source;
	const run = inputs.cloud.get(source.project);
	if (run === undefined) {
		stale.push(`cloud ${source.project}: the text describes a run, and none is recorded`);
		return undefined;
	}
	const { id: _id, ...recorded } = run;
	const count = (status: CloudStepStatus) => run.steps.filter((step) => step.status === status).length;
	const counts: CloudCounts = {
		pass: count("pass"),
		fail: count("fail"),
		notApplicable: count("not-applicable"),
		needsSecrets: count("needs-secrets"),
	};
	if (JSON.stringify(counts) !== JSON.stringify({ pass: writtenFor.pass, fail: writtenFor.fail, notApplicable: writtenFor.notApplicable, needsSecrets: writtenFor.needsSecrets })) {
		stale.push(`cloud ${source.project}: the text describes ${JSON.stringify(writtenFor)}, and the run says ${JSON.stringify(counts)}`);
	}
	return { ...text, ...recorded, counts };
}

function tally<K extends string>(keys: readonly K[], values: readonly K[]): Record<K, number> {
	const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
	for (const value of values) counts[value]++;
	return counts;
}

function failedSteps(projects: readonly ProjectRow[]): TruthTable["summary"]["failedSteps"] {
	const counts = new Map<string, { owner: string; label: string; steps: number }>();
	for (const failure of projects.flatMap((project) => project.failures)) {
		const owner = failure.owner ?? "not-looked-at";
		const entry = counts.get(owner) ?? { owner, label: failure.ownerLabel, steps: 0 };
		entry.steps++;
		counts.set(owner, entry);
	}
	return [...counts.values()].sort((a, b) => b.steps - a.steps || a.owner.localeCompare(b.owner));
}

function emulatedHibernation(inputs: TruthTableInputs, projects: readonly ProjectRow[]): TruthTable["emulatedHibernation"] {
	const steps = projects.flatMap((project) => project.failures).filter((failure) => failure.owner === hibernationOwner);
	const ran = steps.filter((failure) => failure.emulated !== undefined);
	// Only the runs that the numbers come from.
	const runs = inputs.projects.flatMap((project) =>
		project.emulated !== undefined && projects.some((row) => row.id === project.id && row.failures.some((failure) => failure.emulated !== undefined))
			? [project.emulated]
			: [],
	);
	return {
		note: inputs.source.emulatedHibernation.note,
		steps: { pass: ran.filter((failure) => failure.emulated === "pass").length, ran: ran.length, total: steps.length },
		projects: projects.filter((project) => project.failures.some((failure) => failure.emulated === "pass")).length,
		orange: [...new Set(runs.map((run) => run.orange.sha))].sort(),
		rivetkit: [...new Set(runs.map((run) => run.rivetkit))].sort(),
		ranAt: runs.map((run) => run.ranAt).sort().at(-1) ?? "",
	};
}

/**
 * Builds the table. `stale` lists every claim whose text no longer matches its results: the words
 * must change with the facts, so the caller refuses to write the file while it is not empty.
 */
export function buildTruthTable(inputs: TruthTableInputs): { table: TruthTable; stale: string[] } {
	const stale: string[] = [];
	const notices = inputs.source.notices.map((claim) => toClaim(claim, inputs, stale));
	const areas = inputs.source.areas.map(({ claims, ...area }) => ({
		...area,
		claims: claims.map((claim) => toClaim(claim, inputs, stale)),
	}));
	const beyond = inputs.source.beyond.map((claim) => toClaim(claim, inputs, stale));
	const scaling = inputs.source.scaling.map(({ writtenFor, evidence: written, ...row }) => {
		const evidence = written.map((item) => resolveEvidence(item, inputs));
		const status = claimStatus(evidence);
		if (status !== writtenFor) {
			stale.push(`scaling ${row.binding}: the text describes ${writtenFor}, and the results say ${status}`);
		}
		return { ...row, status, evidence };
	});
	const projects = inputs.projects
		.map(projectRow)
		.sort((a, b) => b.stars - a.stars || a.id.localeCompare(b.id));
	const cloud = {
		notes: inputs.source.cloud.notes,
		projects: inputs.source.cloud.projects.flatMap((source) => cloudRow(source, inputs, stale) ?? []),
	};
	const probes = [...inputs.probes.values()].map(({ result }) => result);
	const latest = (values: readonly string[]) => [...values].sort().at(-1) ?? "";
	const table: TruthTable = {
		schemaVersion: 1,
		sources: {
			conformance: {
				date: inputs.conformance.date,
				orange: inputs.conformance.orange.sha,
				rivetkit: inputs.conformance.rivetkit,
				...inputs.conformance.totals.all,
			},
			probes: {
				orange: probes[0]?.orange.sha ?? "",
				rivetkit: probes[0]?.rivetkit ?? "",
				ranAt: latest(probes.map((probe) => probe.ranAt)),
			},
			realProjects: {
				orange: [...new Set(projects.map((project) => project.orange))].sort(),
				rivetkit: [...new Set(projects.map((project) => project.rivetkit))].sort(),
				ranAt: latest(projects.map((project) => project.ranAt)),
			},
			examples: inputs.examples === null ? null : { orange: inputs.examples.orange, ranAt: inputs.examples.ranAt },
		},
		emulatedHibernation: emulatedHibernation(inputs, projects),
		summary: {
			claims: tally(claimStatuses, [
				...notices,
				...areas.flatMap((area) => area.claims),
				...beyond,
				...scaling,
			].map((claim) => claim.status)),
			projects: tally(projectStatuses, projects.map((project) => project.status)),
			unmodified: projects.filter((project) => project.changes.length === 0 && project.status !== "not-run").length,
			failedSteps: failedSteps(projects),
		},
		notices,
		areas,
		beyond,
		scaling,
		projects,
		cloud,
		excluded: inputs.excluded,
	};
	return { table, stale };
}
