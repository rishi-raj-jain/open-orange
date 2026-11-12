import { realProjectStatuses } from "../real-projects/result.js";
import type { StepKind, StepStatus } from "../real-projects/scenario.js";

/** One recorded result a claim rests on. */
export type Evidence =
	/** One test in `results/latest.json`. */
	| { kind: "test"; test: string }
	/** Every scored test of a file id in `results/latest.json`. */
	| { kind: "test-file"; file: string }
	/** Every scored test of an area in `results/latest.json`. */
	| { kind: "area"; area: string }
	/** One step of `probes/<probe>/result.json`. Its `baseline.json` adds what workerd did. */
	| { kind: "probe"; probe: string; step: string }
	/** One step of `real-projects/<project>/result.json`. */
	| { kind: "project"; project: string; step: string }
	/** One example scenario in `results/runnable-examples.json`. */
	| { kind: "example"; example: string }
	/** One step of `repros/<repro>/result.json`, for a fault that needs its own setup. */
	| { kind: "repro"; repro: string; step: string };

export const claimStatuses = ["works", "partial", "does-not-work", "not-run"] as const;
/** Set from the evidence, never by hand: all pass, some pass, none pass, or nothing recorded. */
export type ClaimStatus = (typeof claimStatuses)[number];

/** A claim as written in `compat/truth-table.claims.json`. */
export interface ClaimSource {
	id: string;
	/** What is being claimed, as a short noun phrase. */
	title: string;
	/** Cloudflare's behaviour. */
	cloudflare?: string;
	/** Orange's behaviour. */
	orange: string;
	/** Why it is so. */
	why?: string;
	/** What a user should do about it. */
	action?: string;
	/** Set when support is planned. No date or design is implied. */
	availability?: "coming-soon";
	/** What a user must plan for today, one point each. */
	drawbacks?: string[];
	/** The status this text describes. The build stops when the evidence no longer agrees. */
	writtenFor: ClaimStatus;
	evidence: Evidence[];
}

export interface AreaSource {
	id: string;
	title: string;
	/** One or two sentences that set up the area. */
	summary: string;
	claims: ClaimSource[];
}

export interface ScaleSource {
	binding: string;
	/** The unit that scales out: more of these means more capacity. */
	scalesBy: string;
	/** What runs one unit, and what limits it. */
	detail: string;
	writtenFor: ClaimStatus;
	evidence: Evidence[];
}

export type CloudStepStatus = StepStatus | "not-applicable";

export interface CloudCounts {
	pass: number;
	fail: number;
	notApplicable: number;
	needsSecrets: number;
}

/** One project's run on Rivet Cloud, as written in `compat/truth-table.claims.json`. */
export interface CloudRunSource {
	project: string;
	/** What the project is. */
	what: string;
	/** What ran on Rivet Cloud. */
	ran: string;
	/** Where it falls short, one point each. */
	shortfalls: string[];
	/** The step counts this text describes. The build stops when the recorded run no longer agrees. */
	writtenFor: CloudCounts;
}

export interface TruthTableSource {
	schemaVersion: 1;
	/** Claims a reader must see first. Each one is complete on its own. */
	notices: ClaimSource[];
	areas: AreaSource[];
	/** Places where Orange does more than Cloudflare's platform allows. */
	beyond: ClaimSource[];
	scaling: ScaleSource[];
	/** Real projects on Rivet Cloud. `notes` apply to every project. */
	cloud: { notes: string[]; projects: CloudRunSource[] };
	/** `note` says what emulated hibernation is and what it still costs. Show it with every emulated result. */
	emulatedHibernation: { note: string };
}

export interface EvidenceResult {
	/** The evidence, as written. */
	source: Evidence;
	/** A readable label for the source. */
	label: string;
	orange: "pass" | "fail" | "partial" | "needs-secrets" | "not-run";
	/** Passed and total, when the evidence covers more than one test. */
	counts?: { pass: number; total: number };
	/** What workerd did, when a baseline ran. */
	workerd?: StepStatus;
	/** The exact error of a failed result. */
	error?: string;
}

export interface Claim extends Omit<ClaimSource, "writtenFor" | "evidence"> {
	status: ClaimStatus;
	evidence: EvidenceResult[];
}

export interface Area extends Omit<AreaSource, "claims"> {
	claims: Claim[];
}

export interface ScaleRow extends Omit<ScaleSource, "writtenFor" | "evidence"> {
	status: ClaimStatus;
	evidence: EvidenceResult[];
}

export interface CloudRow extends Omit<CloudRunSource, "writtenFor"> {
	repo: string;
	commit: string;
	directory: string;
	ranAt: string;
	plan: string;
	deployedWith: string;
	counts: CloudCounts;
	steps: { name: string; kind: StepKind; status: CloudStepStatus; note?: string; error?: string; secrets?: string[] }[];
}

/**
 * A run's status, and one more that only the table sets:
 * - `works-emulated`: the only failed steps fail for lack of hibernation, and each one passes under
 *   the emulated sleep gate. It is its own count, never part of `works`.
 */
export const projectStatuses = ["works", "works-emulated", ...realProjectStatuses.filter((status) => status !== "works")] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export interface ProjectFailure {
	step: string;
	kind: StepKind;
	/** The exact error. */
	error: string;
	/** Machine key of the cause. */
	owner?: string;
	/** The cause in plain words, ready to show. */
	ownerLabel: string;
	note?: string;
	reference?: string;
	/**
	 * What the same step did under the emulated sleep gate, for a step that failed because hibernation
	 * is not available. A `pass` here is not a hibernation pass: the step still counts as failed.
	 */
	emulated?: "pass" | "fail";
}

export interface ProjectRow {
	id: string;
	repo: string;
	/** Source tree at the tested commit. */
	url: string;
	commit: string;
	stars: number;
	origin: string;
	/** The Worker's directory in the repository. */
	directory: string;
	status: ProjectStatus;
	/** Steps passed and total. An emulated pass is not in `pass`. */
	steps: { pass: number; total: number };
	/** What the project needed changed. Empty means unmodified. */
	changes: { kind: string; what: string; why: string }[];
	failures: ProjectFailure[];
	/** Credentials that a real deployment of the project would set. */
	secrets: string[];
	/** Why it did not run, or the exact install, build, or boot error. */
	error?: string;
	durableObjects: { classes: string[]; file: string; uses: string[] };
	ranAt: string;
	orange: string;
	rivetkit: string;
}

/**
 * `compat/truth-table.json`: what works and what does not. Generated by `pnpm truth-table` from
 * recorded results. The website and the report both read this file.
 */
export interface TruthTable {
	schemaVersion: 1;
	/** Where each kind of result came from. */
	sources: {
		conformance: { date: string; orange: string; rivetkit: string; pass: number; total: number };
		probes: { orange: string; rivetkit: string; ranAt: string };
		realProjects: { orange: string[]; rivetkit: string[]; ranAt: string };
		examples: { orange: string; ranAt: string } | null;
	};
	/**
	 * Steps that fail because hibernation is not available, run again under the emulated sleep gate.
	 * No emulated pass counts as a step's or a claim's pass. A project that fails only these steps, and
	 * passes them all emulated, gets the status `works-emulated`, apart from `works`.
	 * Always show `note` with these numbers.
	 */
	emulatedHibernation: {
		note: string;
		/** Of the `total` steps that fail for lack of hibernation, `ran` have an emulated result and `pass` passed it. */
		steps: { pass: number; ran: number; total: number };
		/** Projects with at least one emulated pass. */
		projects: number;
		orange: string[];
		rivetkit: string[];
		ranAt: string;
	};
	summary: {
		claims: Record<ClaimStatus, number>;
		projects: Record<ProjectStatus, number>;
		/** Projects with no change at all. */
		unmodified: number;
		/** Failed project steps by cause, most first. `label` is ready to show. */
		failedSteps: { owner: string; label: string; steps: number }[];
	};
	/**
	 * Claims a reader must see first, each complete on its own: `title`, `availability`, `cloudflare`,
	 * `orange` (what it means today), `why`, `action`, and `drawbacks`. Show them above `areas`.
	 */
	notices: Claim[];
	areas: Area[];
	beyond: Claim[];
	scaling: ScaleRow[];
	projects: ProjectRow[];
	/** Real projects on Rivet Cloud, kept apart from the local results in `projects`. */
	cloud: { notes: string[]; projects: CloudRow[] };
	/** Candidates screened out, with why. */
	excluded: { repo: string; stars: number; reason: string }[];
}
