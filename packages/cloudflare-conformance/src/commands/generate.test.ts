import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	generateRuntimeDeclarations,
	runtimeDeclarationsPath,
} from "./generate.js";

test("generates pinned runtime declarations deterministically", async () => {
	await generateRuntimeDeclarations(runtimeDeclarationsPath);
	const firstGeneration = await readFile(runtimeDeclarationsPath);

	await generateRuntimeDeclarations(runtimeDeclarationsPath);
	const secondGeneration = await readFile(runtimeDeclarationsPath);

	assert.deepEqual(secondGeneration, firstGeneration);
	assert.match(
		firstGeneration.toString("utf8"),
		/^\/\* eslint-disable \*\/\n\/\/ Runtime types generated with workerd@/,
	);
});
