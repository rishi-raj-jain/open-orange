import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createApiInventory } from "../generators/api-inventory.js";
import { createWranglerHelpInventory } from "../generators/wrangler-help.js";
import { validateSupport } from "./support.js";

test("accepts current declaration and command claims", async () => {
	const inventory = createApiInventory("declare function atob(value: string): string;\n");
	const helpInventory = await createWranglerHelpInventory(
		async () => "wrangler\n",
		"4.129.0",
	);
	const atob = inventory.declarations.find(
		(declaration) => declaration.kind === "function" && declaration.name === "atob",
	);
	assert.ok(atob);

	assert.deepEqual(
		validateSupport(
			{
				version: 1,
				commands: {
					"": {
						status: "partial",
						helpHash: createHash("sha256")
							.update("wrangler\n")
							.digest("hex"),
					},
				},
				globals: {
					atob: {
						status: "partial",
						declarations: [
							{
								kind: atob.kind,
								name: atob.name,
								signatureHashes: atob.signatureHashes,
							},
						],
					},
				},
				modules: {},
				bindings: {},
				events: {},
			},
			inventory,
			helpInventory,
		),
		[],
	);
});

test("reports removed APIs and changed registered signatures", async () => {
	const inventory = createApiInventory("declare function atob(value: string): string;\n");
	const helpInventory = await createWranglerHelpInventory(
		async () => "wrangler\n",
		"4.129.0",
	);
	const invalidHash = "0".repeat(64);
	const errors = validateSupport(
		{
			version: 1,
			commands: {},
			globals: {
				changed: {
					status: "implemented",
					declarations: [
						{
							kind: "function",
							name: "atob",
							signatureHashes: [invalidHash],
						},
					],
				},
				removed: {
					status: "partial",
					declarations: [
						{
							kind: "class",
							name: "Missing",
							signatureHashes: [invalidHash],
						},
					],
				},
			},
			modules: {},
			bindings: {},
			events: {},
		},
		inventory,
		helpInventory,
	);

	assert.ok(errors.some((error) => error.includes("changed signatures")));
	assert.ok(errors.some((error) => error.includes("removed API")));
});
