import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createLocalSecretSource,
	createSecretsStoreSecret,
	parseDevVars,
} from "./secrets-store.js";

test("parses supported .dev.vars forms without including values in errors", () => {
	assert.deepEqual(
		Object.fromEntries(
			parseDevVars(`
PLAIN=value
export SINGLE='single value'
DOUBLE="line\\nvalue"
COMMENTED=value # ignored
HASH=value#kept
`),
		),
		{
			COMMENTED: "value",
			DOUBLE: "line\nvalue",
			HASH: "value#kept",
			PLAIN: "value",
			SINGLE: "single value",
		},
	);
	assert.throws(
		() => parseDevVars("not a declaration containing-secret-value"),
		(error: unknown) =>
			error instanceof Error &&
			error.message === "Invalid .dev.vars declaration on line 1" &&
			!error.message.includes("containing-secret-value"),
	);
});

test("prefers .dev.vars and falls back to the process environment", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-secrets-"));
	try {
		await writeFile(
			join(directory, ".dev.vars"),
			"FROM_FILE=file-value\nBOTH=file-wins\n",
			{ mode: 0o600 },
		);
		const source = createLocalSecretSource({
			directory,
			environment: {
				BOTH: "environment-loses",
				FROM_ENVIRONMENT: "environment-value",
			},
		});
		assert.equal(
			await createSecretsStoreSecret("FROM_FILE", source).get(),
			"file-value",
		);
		assert.equal(
			await createSecretsStoreSecret("BOTH", source).get(),
			"file-wins",
		);
		assert.equal(
			await createSecretsStoreSecret("FROM_ENVIRONMENT", source).get(),
			"environment-value",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("identifies a missing binding without exposing another value", async () => {
	const binding = createSecretsStoreSecret("MISSING_TOKEN", {
		async resolve(): Promise<string | undefined> {
			return undefined;
		},
	});
	await assert.rejects(
		binding.get(),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("MISSING_TOKEN") &&
			!error.message.includes("unrelated-secret-value"),
	);
});
