import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { summarizeResults } from "./classify.js";
import { compareWithRunDirectory, formatSummary } from "./report.js";
import type { UpstreamFileResult, UpstreamTestResult } from "./run-file.js";

const pass: UpstreamTestResult = { status: "pass", ms: 5 };
const assertFailure: UpstreamTestResult = {
	status: "fail",
	kind: "assert",
	error: "AssertionError: Expected values to be strictly equal",
};
const needsWorkerdTestModule: UpstreamTestResult = {
	status: "fail",
	kind: "assert",
	error: 'Error: Cannot find module "workerd:unsafe"',
};

function fileResult(
	id: string,
	tests: Record<string, UpstreamTestResult>,
): UpstreamFileResult {
	return {
		id,
		file: `${id}.wd-test`,
		service: "main",
		dropped: [],
		boot: { ok: true },
		tests,
	};
}

test("reports new passes and regressions against an earlier results directory", async () => {
	const earlier = await mkdtemp(join(tmpdir(), "upstream-report-test-"));
	try {
		const earlierResults = [
			fileResult("api-tests--streams-test", {
				"main:fixed": assertFailure,
				"main:broken": pass,
				"main:stable": pass,
			}),
			fileResult("node-tests--buffer-test", {
				"main:infra": pass,
				"main:gone": pass,
			}),
			fileResult("node-tests--zlib-test", { "main:unrelated": pass }),
		];
		for (const result of earlierResults) {
			await writeFile(
				join(earlier, `${result.id}.json`),
				JSON.stringify(result),
			);
		}
		await writeFile(join(earlier, "summary.json"), "[]");

		const comparison = await compareWithRunDirectory(earlier, [
			fileResult("api-tests--streams-test", {
				"main:fixed": pass,
				"main:broken": assertFailure,
				"main:stable": pass,
			}),
			fileResult("node-tests--buffer-test", {
				"main:infra": needsWorkerdTestModule,
			}),
		]);

		assert.deepEqual(
			comparison.newlyPassing.map((row) => `${row.file} > ${row.test}`),
			["streams-test > fixed"],
		);
		assert.deepEqual(
			comparison.newlyFailing.map(
				({ before, after }) =>
					`${before.file} > ${before.test}: ${after?.status ?? "not run"}`,
			),
			[
				"streams-test > broken: fail",
				"buffer-test > infra: infra",
				"buffer-test > gone: not run",
			],
		);
	} finally {
		await rm(earlier, { recursive: true, force: true });
	}
});

test("the summary scores Cloudflare APIs and Node.js apart and leaves out workerd-only tests", () => {
	const onNode = (result: UpstreamTestResult, node: "pass" | "fail"): UpstreamTestResult => ({ ...result, node });
	const rows = summarizeResults([
		fileResult("api-tests--streams-test", { "main:a": pass, "main:b": assertFailure }),
		fileResult("node-tests--zlib-test", {
			"main:c": onNode(pass, "pass"),
			"main:d": onNode(assertFailure, "pass"),
			"main:e": onNode(assertFailure, "fail"),
			"main:f": onNode(pass, "fail"),
		}),
	]);

	const lines = formatSummary(2, rows).split("\n");

	assert.equal(lines[0], "files 2  pass 2/4 (50.0%)  infra-excluded 0  workerd-only 2  cloudflare-quota-cut 0");
	assert.equal(lines[2], "cloudflare apis  1/2 (50.0%)");
	assert.equal(lines[3], "node.js          1/2 (50.0%)  (only tests that pass on plain Node.js)");
});
