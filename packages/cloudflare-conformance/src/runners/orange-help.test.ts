import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createOrangeHelpRunner, normalizeOrangeExecutable } from "./orange-help.js";

const repositoryRoot = join(import.meta.dirname, "../../../..");

test("normalizes only the Orange executable name", () => {
	assert.equal(
		normalizeOrangeExecutable("open-orange dev\norange d1\nOpenOrange runs on Node.js.\n"),
		"wrangler dev\nwrangler d1\nOpenOrange runs on Node.js.\n",
	);
});

test("runs a real nested Orange help endpoint", async () => {
	const runHelp = createOrangeHelpRunner(repositoryRoot);
	assert.match(await runHelp(["types"]), /^wrangler types \[path\]\n/);
});
