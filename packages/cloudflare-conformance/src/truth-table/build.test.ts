import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { readTruthTable, readTruthTableInputs, truthTablePath } from "../commands/truth-table.js";
import { buildTruthTable, type TruthTableInputs } from "./build.js";

test("compat/truth-table.json is exactly what the recorded results produce", { skip: !existsSync(truthTablePath) }, async () => {
	const { table, stale } = buildTruthTable(await readTruthTableInputs());
	assert.deepEqual(stale, []);
	assert.deepEqual(await readTruthTable(), JSON.parse(JSON.stringify(table)));
});

function inputs(step: "pass" | "fail" | undefined, writtenFor: "works" | "does-not-work" | "not-run"): TruthTableInputs {
	const steps = step === undefined ? [] : [{ name: "cos runs", kind: "do-state" as const, status: step, seconds: 0, error: step === "fail" ? "no such function: cos" : undefined }];
	return {
		source: {
			schemaVersion: 1,
			notices: [],
			areas: [
				{
					id: "sqlite",
					title: "SQLite",
					summary: "",
					claims: [
						{
							id: "math",
							title: "cos",
							orange: "words",
							writtenFor,
							evidence: [{ kind: "probe", probe: "surface", step: "cos runs" }],
						},
					],
				},
			],
			beyond: [],
			scaling: [],
			cloud: { notes: [], projects: [] },
			emulatedHibernation: { note: "what it costs" },
		},
		cloud: new Map(),
		conformance: { date: "2026-11-03", orange: { sha: "abc", dirty: null }, rivetkit: "x", totals: { all: { pass: 0, total: 0 } }, files: [], tests: [], perArea: {} } as never,
		probes: new Map([["surface", { result: { steps, orange: { sha: "abc" }, rivetkit: "x", ranAt: "2026-11-03" } as never }]]),
		projects: [],
		examples: null,
		repros: new Map(),
		excluded: [],
	};
}

test("a claim follows its result, and the exact error reaches the table", () => {
	const { table, stale } = buildTruthTable(inputs("fail", "does-not-work"));
	assert.deepEqual(stale, []);
	const claim = table.areas[0]!.claims[0]!;
	assert.equal(claim.status, "does-not-work");
	assert.equal(claim.evidence[0]!.error, "no such function: cos");
});

test("when a result changes, the build names the claim whose text is now wrong", () => {
	const { stale } = buildTruthTable(inputs("pass", "does-not-work"));
	assert.deepEqual(stale, ["math: the text describes does-not-work, and the results say works"]);
});

test("a step failed by a missing feature stays in the failed count, under a reason ready to show", () => {
	const input = inputs("fail", "does-not-work");
	input.projects = [
		{
			id: "chat",
			repo: "a/chat",
			commit: "0".repeat(40),
			stars: 1,
			origin: "search",
			directory: ".",
			status: "partial",
			install: null,
			build: null,
			boot: null,
			steps: [
				{ name: "socket", kind: "sleep", status: "fail", seconds: 1, error: "WebSocket closed (1012 actor.stopped)" },
				{ name: "state", kind: "do-state", status: "pass", seconds: 1 },
			],
			changes: [],
			knownFailures: [{ step: "socket", owner: "hibernation-not-available", note: "n" }],
			durableObjects: { classes: ["A"], file: "a.ts", uses: ["x"] },
			ranAt: "2026-11-04",
			orange: { sha: "abc", dirty: null },
			rivetkit: "x",
		} as never,
	];
	const { table } = buildTruthTable(input);
	assert.deepEqual(table.summary.failedSteps, [
		{ owner: "hibernation-not-available", label: "WebSocket hibernation not available on Rivet 3", steps: 1 },
	]);
	assert.equal(table.projects[0]!.status, "partial");
});

test("an emulated pass is shown beside a hibernation failure, and the step stays failed", () => {
	const run = {
		id: "chat",
		repo: "a/chat",
		commit: "0".repeat(40),
		stars: 1,
		origin: "search",
		directory: ".",
		status: "partial",
		install: null,
		build: null,
		boot: null,
		steps: [
			{ name: "socket", kind: "sleep", status: "fail", seconds: 1, error: "Some actor was still awake" },
			{ name: "alarm", kind: "alarm", status: "fail", seconds: 1, error: "no alarm" },
			{ name: "state", kind: "do-state", status: "pass", seconds: 1 },
		],
		changes: [],
		durableObjects: { classes: ["A"], file: "a.ts", uses: ["x"] },
		ranAt: "2026-11-04",
		orange: { sha: "abc", dirty: null },
		rivetkit: "x",
	};
	const emulated = {
		...run,
		status: "works",
		sleepGate: "emulated",
		orange: { sha: "def", dirty: null },
		// The emulated run passes the alarm step too, and that failure has another cause.
		steps: run.steps.map((step) => ({ ...step, status: "pass", error: undefined })),
	};
	const input = inputs("fail", "does-not-work");
	const knownFailures = [
		{ step: "socket", owner: "hibernation-not-available", note: "n" },
		{ step: "alarm", owner: "orange", note: "n" },
	];
	input.projects = [{ ...run, knownFailures, emulated } as never];
	const { table } = buildTruthTable(input);
	const project = table.projects[0]!;
	assert.deepEqual(project.steps, { pass: 1, total: 3 });
	assert.deepEqual(project.failures.map((failure) => [failure.step, failure.emulated]), [["socket", "pass"], ["alarm", undefined]]);
	assert.equal(table.summary.projects.works, 0);
	assert.equal(table.summary.failedSteps.find((entry) => entry.owner === "hibernation-not-available")!.steps, 1);
	assert.deepEqual(table.emulatedHibernation, { note: "what it costs", steps: { pass: 1, ran: 1, total: 1 }, projects: 1, orange: ["def"], rivetkit: ["x"], ranAt: "2026-11-04" });

	input.projects = [{ ...run, knownFailures } as never];
	const without = buildTruthTable(input).table;
	assert.deepEqual(without.emulatedHibernation.steps, { pass: 0, ran: 0, total: 1 });
	assert.equal(without.projects[0]!.failures[0]!.emulated, undefined);
});

test("a project gets the emulated status only when emulation covers every failure, and never the plain one", () => {
	const step = (name: string, status: string) => ({ name, kind: name === "socket" ? "sleep" : "do-state", status, seconds: 1, ...(status === "fail" ? { error: "e" } : {}) });
	const project = (id: string, steps: unknown[], emulatedSocket: string | undefined) => {
		const run = { id, repo: `a/${id}`, commit: "0".repeat(40), stars: 1, origin: "search", directory: ".", status: "partial", install: null, build: null, boot: null, steps, changes: [], durableObjects: { classes: ["A"], file: "a.ts", uses: [] }, ranAt: "2026-11-04", orange: { sha: "abc", dirty: null }, rivetkit: "x" };
		return {
			...run,
			knownFailures: [{ step: "socket", owner: "hibernation-not-available", note: "n" }],
			...(emulatedSocket === undefined ? {} : { emulated: { ...run, steps: [step("socket", emulatedSocket)] } }),
		} as never;
	};
	const input = inputs("fail", "does-not-work");
	input.projects = [
		project("covered", [step("socket", "fail"), step("state", "pass")], "pass"),
		project("other-failure", [step("socket", "fail"), step("state", "pass"), step("alarm", "fail")], "pass"),
		project("emulation-fails", [step("socket", "fail"), step("state", "pass")], "fail"),
		project("no-emulated-run", [step("socket", "fail"), step("state", "pass")], undefined),
		project("needs-a-secret", [step("socket", "fail"), step("state", "pass"), step("login", "needs-secrets")], "pass"),
	];
	const { table } = buildTruthTable(input);
	assert.deepEqual(Object.fromEntries(table.projects.map((row) => [row.id, row.status])), {
		covered: "works-emulated",
		"other-failure": "partial",
		"emulation-fails": "partial",
		"no-emulated-run": "partial",
		"needs-a-secret": "partial",
	});
	assert.deepEqual(table.summary.projects, { works: 0, "works-emulated": 1, partial: 4, fails: 0, "needs-secrets": 0, "not-run": 0 });
	assert.deepEqual(table.projects.find((row) => row.id === "covered")!.steps, { pass: 1, total: 2 });
});

test("a claim with no recorded result is not run, whatever its text says", () => {
	const { table, stale } = buildTruthTable(inputs(undefined, "works"));
	assert.equal(table.areas[0]!.claims[0]!.status, "not-run");
	assert.equal(stale.length, 1);
});

test("when a cloud run's counts change, the build names the project whose text is now wrong", () => {
	const base = inputs("pass", "works");
	const writtenFor = { pass: 1, fail: 0, notApplicable: 0, needsSecrets: 0 };
	const run = { id: "demo", repo: "a/b", commit: "c", directory: ".", ranAt: "2026-11-05", plan: "Free", deployedWith: "rivet deploy" };
	const source = { ...base.source, cloud: { notes: [], projects: [{ project: "demo", what: "w", ran: "r", shortfalls: [], writtenFor }] } };
	const passed = new Map([["demo", { ...run, steps: [{ name: "s", kind: "http" as const, status: "pass" as const }] }]]);
	const failed = new Map([["demo", { ...run, steps: [{ name: "s", kind: "http" as const, status: "fail" as const, error: "boom" }] }]]);
	assert.deepEqual(buildTruthTable({ ...base, source, cloud: passed }).stale, []);
	assert.match(buildTruthTable({ ...base, source, cloud: failed }).stale.join(), /cloud demo: the text describes/);
	assert.match(buildTruthTable({ ...base, source, cloud: new Map() }).stale.join(), /cloud demo: .*none is recorded/);
});

test("the published cloud results name no deployment", { skip: !existsSync(truthTablePath) }, async () => {
	const { cloud } = await readTruthTable();
	assert.equal(cloud.projects.length, 6);
	assert.doesNotMatch(JSON.stringify(cloud), /onrivet\.dev|\boo-[a-z]+|[0-9a-f]{8}-[0-9a-f]{4}-|https?:\/\//);
});
