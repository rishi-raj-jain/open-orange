import assert from "node:assert/strict";
import test from "node:test";

import { isScored, summarizeResults } from "./classify.js";
import type { UpstreamFileResult, UpstreamTestResult } from "./run-file.js";

// Failures copied from the workerd v1.20260903.1 reference run against orange dev.
const buildFailedOnUnsafe =
	'Build failed with 1 error:\nproj/api-tests--actor-alarms-name-test/src/worker.js:6:19: ERROR: Could not resolve "workerd:unsafe"\n';
const buildFailedOnImport =
	'Build failed with 1 error:\nproj/api-tests--module-test/src/bad-static-import.js:1:7: ERROR: Could not resolve "../dep"\n';
const referenceFailures: Array<{
	id: string;
	dropped?: string[];
	bootDetail?: string;
	test: UpstreamTestResult;
	expected: { status: string; cause: string };
}> = [
	{
		id: "api-tests--actor-alarms-name-test",
		bootDetail: buildFailedOnUnsafe,
		test: { status: "fail", kind: "boot", error: buildFailedOnUnsafe },
		expected: { status: "infra", cause: "test-infra" },
	},
	{
		id: "api-tests--module-test",
		bootDetail: buildFailedOnImport,
		test: { status: "fail", kind: "boot", error: buildFailedOnImport },
		expected: { status: "fail", cause: "Bundling fails" },
	},
	{
		id: "api-tests--analytics-engine-test",
		dropped: ["binding aebinding (analyticsEngine)"],
		test: {
			status: "fail",
			kind: "assert",
			error:
				"TypeError: Cannot read properties of undefined (reading 'writeDataPoint')\n    at Object.test (src/worker.js:22:19)",
		},
		expected: { status: "fail", cause: "Unsupported binding" },
	},
	{
		id: "api-tests--cache-test",
		test: {
			status: "fail",
			kind: "assert",
			error:
				"Error: Cloudflare global caches is not implemented by OpenOrange\n    at Object.fail (src/globals/unimplemented.ts:3:9)",
		},
		expected: { status: "fail", cause: "Missing CF globals" },
	},
	{
		id: "api-tests--crypto-extras-test",
		test: {
			status: "fail",
			kind: "assert",
			error:
				"NotSupportedError: Unrecognized algorithm name\n    at normalizeAlgorithm (node:internal/crypto/util:645:11)",
		},
		expected: { status: "fail", cause: "Not-implemented API" },
	},
	{
		id: "api-tests--importable-env-test",
		dropped: ["binding CACHE (memoryCache)"],
		bootDetail:
			"The expression evaluated to a falsy value:\n\n  ok(env.CACHE)\n\n",
		test: {
			status: "fail",
			kind: "boot",
			error:
				"The expression evaluated to a falsy value:\n\n  ok(env.CACHE)\n\n",
		},
		expected: { status: "fail", cause: "File fails at load" },
	},
	{
		id: "node-tests--fs-nodejs-test",
		test: {
			status: "fail",
			kind: "assert",
			error:
				"Error: ENOENT: no such file or directory, chdir '/workspace/orange' -> '/bundle'",
		},
		expected: {
			status: "fail",
			cause: "fs is the host disk, not a virtual fs",
		},
	},
	{
		id: "node-tests--string-decoder-test",
		test: {
			status: "fail",
			kind: "crash",
			error: "orange process exited while running this test: ",
		},
		expected: { status: "fail", cause: "One test crashes the whole runtime" },
	},
	{
		id: "api-tests--cross-context-promise-test",
		test: {
			status: "fail",
			kind: "hang",
			error: "TimeoutError: The operation was aborted due to timeout",
		},
		expected: { status: "fail", cause: "Hangs (60s timeout)" },
	},
	{
		id: "api-tests--abortable-fetch-test",
		test: {
			status: "fail",
			kind: "assert",
			error:
				"TypeError: Failed to parse URL from \n    at new Request (undici/lib/web/fetch/request.js:143:15)",
		},
		expected: { status: "fail", cause: "Behavior differs" },
	},
];

function fileResult(
	id: string,
	tests: Record<string, UpstreamTestResult>,
	extra: Partial<UpstreamFileResult> = {},
): UpstreamFileResult {
	return {
		id,
		file: `${id}.wd-test`,
		service: "main",
		dropped: [],
		boot: { ok: true },
		tests,
		...extra,
	};
}

test("maps real reference-run failures to their causes", () => {
	for (const failure of referenceFailures) {
		const [row] = summarizeResults([
			fileResult(
				failure.id,
				{ "main:case": failure.test },
				{
					dropped: failure.dropped ?? [],
					boot:
						failure.bootDetail === undefined
							? { ok: true }
							: { ok: false, reason: "exit 1", detail: failure.bootDetail },
				},
			),
		]);
		assert.deepEqual(
			{ status: row?.status, cause: row?.cause },
			failure.expected,
			failure.id,
		);
	}
});

test("scores only tests of the ported service and names them without the service prefix", () => {
	const rows = summarizeResults([
		fileResult("api-tests--actor-kv-test", {
			main: { status: "pass", ms: 223 },
			"tail:test": { status: "other-service" },
		}),
	]);
	assert.deepEqual(rows, [
		{
			file: "actor-kv-test",
			area: "Durable Objects",
			test: "main",
			status: "pass",
			cause: null,
			error: "",
		},
	]);
});

test("keeps tests of a not-supported file in the total and names the reason", () => {
	const rows = summarizeResults(
		[
			fileResult("api-tests--webfs-test", {
				"main:write": {
					status: "fail",
					kind: "boot",
					error: "StorageManager is not defined",
				},
				"main:read": { status: "pass", ms: 4 },
			}),
		],
		{ "api-tests--webfs-test": "Needs an experimental flag." },
	);
	assert.deepEqual(
		rows.map((row) => [row.test, row.status, row.cause, row.why]),
		[
			["write", "fail", "Not supported", "Needs an experimental flag."],
			["read", "pass", null, undefined],
		],
	);
});

test("scores Orange-written synthetic files as Durable Objects under their own file name", () => {
	const [row] = summarizeResults([
		fileResult("synthetic--do-storage-test", {
			"main:listWithLimit": { status: "pass", ms: 12 },
		}),
	]);
	assert.deepEqual(
		{ file: row?.file, area: row?.area, test: row?.test },
		{
			file: "synthetic--do-storage-test",
			area: "Durable Objects",
			test: "listWithLimit",
		},
	);
});

test("labels a failing test that relies on behavior Cloudflare does not guarantee, and still counts it", () => {
	const rows = summarizeResults(
		[
			fileResult("api-tests--request-signal-enabled", {
				"main:abortIfClientAbandonsRequest": {
					status: "fail",
					kind: "assert",
					error: "AssertionError: false !== true",
				},
				"main:noAbortOnSimpleResponse": { status: "pass", ms: 4 },
			}),
		],
		{},
		{ "api-tests--request-signal-enabled > abortIfClientAbandonsRequest": "No ordering between stubs." },
	);
	assert.deepEqual(
		rows.map((row) => [row.test, row.status, row.cause, row.why]),
		[
			["abortIfClientAbandonsRequest", "fail", "Relies on behavior Cloudflare does not guarantee", "No ordering between stubs."],
			["noAbortOnSimpleResponse", "pass", null, undefined],
		],
	);
});

test("cuts a listed Cloudflare quota test from the score whether it passes or fails, and keeps what Orange did", () => {
	const rows = summarizeResults(
		[
			fileResult("api-tests--global-scope-test", {
				"main:timeoutCount": { status: "fail", kind: "assert", error: "Missing expected exception." },
				"main:timeoutClamping": { status: "pass", ms: 3 },
			}),
			fileResult("api-tests--blob-test", { "main:overLarge": { status: "pass", ms: 9 } }),
		],
		{},
		{},
		{
			"api-tests--global-scope-test > timeoutCount": "At most 10,000 active timeouts per event",
			"api-tests--blob-test > overLarge": "A Blob of at most 128 MiB",
		},
	);
	assert.deepEqual(
		rows.map((row) => [row.test, row.status, row.outcome, row.quota, isScored(row)]),
		[
			["timeoutCount", "quota", "fail", "At most 10,000 active timeouts per event", false],
			["timeoutClamping", "pass", undefined, undefined, true],
			["overLarge", "quota", "pass", "A Blob of at most 128 MiB", false],
		],
	);
});
