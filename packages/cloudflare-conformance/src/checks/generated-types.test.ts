import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { generatedTypesFixtures } from "../generated-types-fixtures.js";
import { checkGeneratedTypesFixtures } from "./generated-types.js";

const repositoryRoot = join(import.meta.dirname, "../../../..");

test("matches Wrangler types and runtime binding factories", async () => {
	assert.deepEqual(
		await checkGeneratedTypesFixtures(generatedTypesFixtures, repositoryRoot),
		[],
	);
});
