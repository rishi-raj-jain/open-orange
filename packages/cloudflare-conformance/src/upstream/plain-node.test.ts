import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runOnPlainNode } from "./plain-node.js";
import { createScratch, remapTmpPaths, removeScratch } from "./tmp-remap.js";

async function run(
	source: string,
	tests: string[],
	extra: { resetDirectory?: string; testTimeoutMs?: number } = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "plain-node-test-"));
	try {
		await writeFile(join(directory, "package.json"), '{"type":"module"}');
		await writeFile(join(directory, "worker.js"), source);
		return await runOnPlainNode({
			directory,
			main: "worker.js",
			tests,
			env: { NAME: "orange" },
			nodeFlags: [],
			logPath: join(directory, "node.log"),
			timeoutMs: 60_000,
			...extra,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("plain Node.js fails a test that ends the process and still runs the tests after it", async () => {
	const outcomes = await run(
		`
export const usesEnv = { test(ctrl, env) { if (env.NAME !== "orange") throw new Error("no env"); } };
export const fails = { test() { throw new Error("workerd only"); } };
export const exits = { test() { process.exit(3); } };
export const after = { async test() {} };
`,
		["usesEnv", "fails", "exits", "after"],
	);

	assert.equal(outcomes.usesEnv?.status, "pass");
	assert.equal(outcomes.fails?.status, "fail");
	assert.match(outcomes.fails?.error ?? "", /workerd only/);
	assert.deepEqual(outcomes.exits, {
		status: "fail",
		error: "plain Node.js exited while running this test (exit=3)",
	});
	assert.equal(outcomes.after?.status, "pass");
});

test("a hung test fails, and the tests after it run in a new process that it cannot disturb", async () => {
	const outcomes = await run(
		`
let disturbed = false;
export const hangs = { test() { setTimeout(() => { disturbed = true; }, 350); return new Promise(() => {}); } };
export const after = { async test() { await new Promise((resolve) => setTimeout(resolve, 200)); if (disturbed) throw new Error("disturbed"); } };
`,
		["hangs", "after"],
		{ testTimeoutMs: 300 },
	);

	assert.deepEqual(outcomes, {
		hangs: { status: "fail", error: "timed out after 300 ms" },
		after: { status: "pass" },
	});
});

test("plain Node.js does not judge a test that imports a cloudflare: module", async () => {
	const outcomes = await run(
		`import { env } from "cloudflare:workers";\nexport const a = { test() {} };`,
		["a"],
	);

	assert.equal(outcomes.a?.status, "not-run");
});

test("a /tmp-remapped test writes only in its scratch directory, which is empty again for the next test", async () => {
	const name = `oo-remap-test-${randomUUID()}`;
	const scratch = await createScratch();
	try {
		const source = remapTmpPaths(
			`
import { existsSync, readFileSync, writeFileSync } from "node:fs";
export const writes = { test() {
	writeFileSync("/tmp/${name}", "x");
	if (readFileSync(\`/tmp/${name}\`, "utf8") !== "x") throw new Error("not written");
} };
export const startsEmpty = { test() {
	if (existsSync(new URL("file:///tmp/${name}"))) throw new Error("left over from the last test");
} };
`,
			scratch.tmp,
		);
		const outcomes = await run(source, ["writes", "startsEmpty"], { resetDirectory: scratch.tmp });

		assert.deepEqual(outcomes, { writes: { status: "pass" }, startsEmpty: { status: "pass" } });
		assert.equal(existsSync(join("/tmp", name)), false);
	} finally {
		await removeScratch(scratch);
	}
	assert.equal(existsSync(scratch.root), false);
	// A /tmp path the rewrite cannot place stops the file instead of reaching the host.
	assert.throws(() => remapTmpPaths(`readFileSync("/var/tmp/x")`, scratch.tmp), /left 1 \/tmp references/);
});
