import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SummaryRow } from "../upstream/classify.js";
import type { UpstreamFileResult } from "../upstream/run-file.js";
import {
	type HistoryEntry,
	type RunSnapshot,
	readRunSnapshot,
	saveRun,
} from "./save.js";

const ids = [
	"api-tests--streams-test",
	"node-tests--streams-test",
	"api-tests--webfs-test",
	"synthetic--do-sql-test",
	"node-tests--fs-stat-test",
];

const rows: SummaryRow[] = [
	{ file: "streams-test", area: "Streams", test: "pipe", status: "pass", cause: null, error: "" },
	{ file: "streams-test", area: "Node.js compat", test: "readable", status: "fail", cause: "Behavior differs", why: "x", error: "AssertionError: 0 == 1 |     at Evaluator.evaluateImpl (/home/someone/dev/orange/node_modules/capnweb/src/x.ts:1:2) |     at y", node: "pass" },
	{ file: "streams-test", area: "Node.js compat", test: "workerdOnly", status: "fail", cause: "Behavior differs", why: "x", error: "AssertionError: 2 == 3", node: "fail", nodeError: "AssertionError: 4 == 5 |     at y" },
	{ file: "streams-test", area: "Node.js compat", test: "gc", status: "infra", cause: "test-infra", why: "x", error: "ReferenceError: gc is not defined" },
	{ file: "webfs-test", area: "Web platform", test: "webfsTest", status: "fail", cause: "Not supported", why: "Needs an experimental flag.", error: "TypeError: x" },
	{ file: "synthetic--do-sql-test", area: "Durable Objects", test: "execMulti", status: "pass", cause: null, error: "" },
	{ file: "synthetic--do-sql-test", area: "Durable Objects", test: "deleteWithLimit", status: "fail", cause: "/home/someone/dev/checkout/packages/runtime-node/src/a.ts lacks exports", why: "x", error: `Error: near "LIMIT": syntax error | ${"a".repeat(300)}` },
	{ file: "fs-stat-test", area: "Node.js compat", test: "statTest", status: "remapped-pass", cause: null, error: "", node: "pass" },
	{ file: "fs-stat-test", area: "Node.js compat", test: "lstatTest", status: "remapped-fail", cause: "Behavior differs", why: "x", error: "Error: ENOENT: no such file or directory, lstat '/tmp/oo-fs-scratch-AbC123/tmp/link'", node: "pass" },
	{ file: "fs-stat-test", area: "Node.js compat", test: "rootTest", status: "remapped-fail", cause: "Behavior differs", why: "x", error: "AssertionError: / differs", node: "fail", nodeError: "AssertionError: / differs" },
];

async function writeRun(directory: string, startedAt: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "summary.json"), JSON.stringify(rows));
	await writeFile(
		join(directory, "run.json"),
		JSON.stringify({
			workerd: { tag: "v1", commit: "abc" },
			files: ids.length,
			filter: null,
			engineBinary: null,
			orange: { sha: "0123456789abcdef0123456789abcdef01234567", dirty: false },
			rivetkit: "1.2.3",
			startedAt,
			wallSeconds: 60,
		}),
	);
	for (const id of ids) {
		const result: UpstreamFileResult = { id, file: `${id}.wd-test`, service: "main", dropped: [], boot: { ok: true }, tests: {} };
		await writeFile(join(directory, `${id}.json`), JSON.stringify(result));
	}
}

test("saving a run writes a compact snapshot, latest.json, and history that keeps manual entries", async () => {
	const root = await mkdtemp(join(tmpdir(), "results-save-test-"));
	try {
		const results = join(root, "results");
		const manual: HistoryEntry = { source: "manual", date: "2026-01-01", label: "first", sha: null, rivetkit: null, pass: 1, total: 4, synthetic: null, perArea: null };
		await mkdir(results);
		await writeFile(join(results, "history.json"), JSON.stringify([manual]));
		await writeRun(join(root, "run"), "2026-02-03T04:05:06.000Z");

		const { path } = await saveRun({ runDirectory: join(root, "run"), resultsDirectory: results, label: "PR #2" });

		assert.equal(path, join(results, "runs/2026-02-03-0123456.json"));
		const snapshot = JSON.parse(await readFile(path, "utf8")) as RunSnapshot;
		const { files, tests, ...summary } = snapshot;
		assert.deepEqual(summary, {
			schemaVersion: 3,
			date: "2026-02-03",
			startedAt: "2026-02-03T04:05:06.000Z",
			wallSeconds: 60,
			label: "PR #2",
			note: null,
			orange: { sha: "0123456", dirty: false },
			rivetkit: "1.2.3",
			engine: { binary: null },
			workerd: { tag: "v1", commit: "abc" },
			unverified: [],
			totals: {
				files: 5,
				syntheticFiles: 1,
				all: { pass: 2, total: 5 },
				upstream: { pass: 1, total: 3 },
				synthetic: { pass: 1, total: 2 },
				cloudflare: { pass: 1, total: 2 },
				node: { pass: 0, total: 1 },
				infraExcluded: 1,
				cloudflareQuotaCut: 0,
				workerdOnly: 2,
				// Neither pass nor fail: kept out of every score above.
				remapped: { pass: 1, total: 2 },
			},
			perArea: {
				"Node.js compat": { pass: 0, total: 1 },
				Streams: { pass: 1, total: 1 },
				"Web platform": { pass: 0, total: 1 },
			},
			perCause: { "Behavior differs": 1, "Not supported": 1, "packages/runtime-node/src/a.ts lacks exports": 1 },
			notSupported: { "api-tests--webfs-test": "Needs an experimental flag." },
		});
		// Files with the same name in different test directories keep their own ids.
		assert.deepEqual(
			files.map((file) => [file.id, file.synthetic, file.pass, file.total, file.infra, file.workerdOnly]),
			[
				["api-tests--streams-test", false, 1, 1, 0, 0],
				["api-tests--webfs-test", false, 0, 1, 0, 0],
				["node-tests--fs-stat-test", false, 0, 0, 0, 1],
				["node-tests--streams-test", false, 0, 1, 1, 1],
				["synthetic--do-sql-test", true, 1, 2, 0, 0],
			],
		);
		const readable = tests.find((row) => row.test === "readable");
		assert.deepEqual(readable, { file: "node-tests--streams-test", area: "Node.js compat", test: "readable", status: "fail", cause: "Behavior differs", error: "AssertionError: 0 == 1", node: "pass" });
		// A test that also fails on plain Node.js keeps why, but no score counts it.
		assert.deepEqual(tests.find((row) => row.test === "workerdOnly"), { file: "node-tests--streams-test", area: "Node.js compat", test: "workerdOnly", status: "fail", cause: "Behavior differs", error: "AssertionError: 2 == 3", node: "fail", nodeError: "AssertionError: 4 == 5" });
		assert.equal(tests.find((row) => row.test === "deleteWithLimit")?.error?.length, 200);
		assert.equal(tests.find((row) => row.test === "deleteWithLimit")?.cause, "packages/runtime-node/src/a.ts lacks exports");
		// Errors name the path the test used, not the runner's scratch directory.
		assert.equal(tests.find((row) => row.test === "lstatTest")?.error, "Error: ENOENT: no such file or directory, lstat '/tmp/link'");
		assert.equal("error" in (tests.find((row) => row.test === "pipe") ?? {}), false);

		assert.deepEqual(JSON.parse(await readFile(join(results, "latest.json"), "utf8")), snapshot);
		const history = JSON.parse(await readFile(join(results, "history.json"), "utf8")) as HistoryEntry[];
		assert.deepEqual(history, [
			manual,
			{
				source: "run",
				date: "2026-02-03",
				label: "PR #2",
				sha: "0123456",
				rivetkit: "1.2.3",
				pass: 1,
				total: 3,
				synthetic: { pass: 1, total: 2 },
				cloudflare: { pass: 1, total: 2 },
				node: { pass: 0, total: 1 },
				perArea: snapshot.perArea,
				run: "runs/2026-02-03-0123456.json",
			},
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a schema 1 snapshot reads with Cloudflare and Node.js totals taken from its areas", async () => {
	const root = await mkdtemp(join(tmpdir(), "results-schema-1-test-"));
	try {
		const path = join(root, "run.json");
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				totals: {
					files: 2,
					syntheticFiles: 0,
					all: { pass: 7, total: 10 },
					upstream: { pass: 7, total: 10 },
					synthetic: { pass: 0, total: 0 },
					infraExcluded: 0,
				},
				perArea: { "Node.js compat": { pass: 4, total: 6 }, Streams: { pass: 3, total: 4 } },
				files: [{ id: "node-tests--zlib-test", area: "Node.js compat", synthetic: false, pass: 4, total: 6, infra: 0 }],
				tests: [],
			}),
		);

		const snapshot = await readRunSnapshot(path);

		assert.equal(snapshot.schemaVersion, 1);
		assert.deepEqual(snapshot.totals.cloudflare, { pass: 3, total: 4 });
		assert.deepEqual(snapshot.totals.node, { pass: 4, total: 6 });
		assert.equal(snapshot.totals.workerdOnly, 0);
		assert.equal(snapshot.files[0]?.workerdOnly, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
