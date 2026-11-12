import assert from "node:assert/strict";
import test from "node:test";

import { createApiInventory } from "./api-inventory.js";
import { createGlobalInventory } from "./global-inventory.js";

test("keeps only declared values exposed by the pinned runtime", () => {
	const apiInventory = createApiInventory(`
		declare function atob(value: string): string;
		declare class BindingOnly {}
		interface TypeOnly {}
	`);
	const inventory = createGlobalInventory(
		apiInventory,
		["Object", "atob"],
		{
			binaryPath: "/workerd",
			compatibilityDate: "2026-09-03",
			version: "1.20260903.1",
		},
	);

	assert.deepEqual(
		inventory.globals.map((entry) => entry.name),
		["atob"],
	);
	assert.deepEqual(inventory.globals[0]?.declarations[0]?.kind, "function");
});
