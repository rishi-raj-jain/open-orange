import assert from "node:assert/strict";
import test from "node:test";

import { runtimeDeclarationsPath } from "../commands/generate.js";
import {
	fetchEventFixturePath,
	invalidFetchEventFixturePath,
} from "../event-fixtures.js";
import { compileWorkerEventFixture } from "./events.js";

test("compiles a module Worker against the exact fetch-handler contract", async () => {
	assert.deepEqual(
		await compileWorkerEventFixture(
			runtimeDeclarationsPath,
			fetchEventFixturePath,
		),
		[],
	);
});

test("rejects a Worker with an invalid fetch response", async () => {
	const diagnostics = await compileWorkerEventFixture(
		runtimeDeclarationsPath,
		invalidFetchEventFixturePath,
	);
	assert.ok(diagnostics.length > 0);
	assert.ok(
		diagnostics.some(
			(diagnostic) =>
				diagnostic.code === 2322 && diagnostic.message.includes("Response"),
		),
	);
});
