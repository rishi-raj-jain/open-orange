import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { checkDurableObjectMatrix } from "./durable-objects.js";
import { packageRoot } from "../commands/generate.js";
import inventory from "../../generated/cloudflare-surface.json" with { type: "json" };

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

test("classifies every pinned Durable Object declaration and member", async () => {
	const matrix = await readJson(join(packageRoot, "durable-objects.json"));
	assert.deepEqual(
		checkDurableObjectMatrix(matrix, inventory),
		[],
	);
});

test("rejects missing, extra, and invalid Durable Object classifications", () => {
	const fixtureInventory = {
		declarations: [
			{
				kind: "interface",
				members: [
					{ kind: "method", name: "get", signatureHashes: ["member"] },
				],
				name: "DurableObjectExample",
				signatureHashes: ["declaration"],
			},
		],
		moduleSpecifiers: [],
		schemaVersion: 1,
		source: {
			path: "cloudflare-runtime.d.ts",
			sha256: "fixture",
			typescriptVersion: "fixture",
		},
	};
	assert.deepEqual(
		checkDurableObjectMatrix(
			{
				declarations: {
					"global:DurableObjectExample": {
						decision: "maybe",
						members: { "method:extra": "included" },
					},
					"global:DurableObjectExtra": {
						decision: "included",
						members: {},
					},
				},
				version: 1,
			},
			fixtureInventory,
		),
		[
			"Durable Object matrix is missing a valid global:DurableObjectExample declaration",
			"Durable Object matrix contains unknown declaration global:DurableObjectExtra",
		],
	);
});
