import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { checkDurableObjectFixtures } from "./durable-object-fixtures.js";
import { packageRoot } from "../commands/generate.js";

test("tracks valid included and excluded Durable Object failure fixtures", async () => {
	assert.deepEqual(
		await checkDurableObjectFixtures(
			packageRoot,
			join(packageRoot, "generated", "cloudflare-runtime.d.ts"),
		),
		[],
	);
});
