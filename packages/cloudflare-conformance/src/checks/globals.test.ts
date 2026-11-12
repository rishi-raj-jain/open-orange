import assert from "node:assert/strict";
import test from "node:test";

import type { GlobalInventory } from "../generators/global-inventory.js";
import { checkGlobalManifest } from "./globals.js";

const inventory: GlobalInventory = {
	schemaVersion: 1,
	source: {
		apiInventorySha256: "0".repeat(64),
		compatibilityDate: "2026-09-03",
		workerdVersion: "1.20260903.1",
	},
	globals: [
		{ name: "atob", declarations: [] },
		{ name: "btoa", declarations: [] },
	],
};

test("accepts exact runtime global manifest keys", () => {
	assert.deepEqual(
		checkGlobalManifest(inventory, [
			{ name: "atob", status: "unimplemented" },
			{ name: "btoa", status: "unimplemented" },
		], new Map()),
		[],
	);
});

test("reports missing, extra, duplicate, and invalid global entries", () => {
	const errors = checkGlobalManifest(inventory, [
		{ name: "atob", status: "unknown" },
		{ name: "atob", status: "unimplemented" },
		{ name: "extra", status: "unimplemented" },
	], new Map([["btoa", "partial"], ["missing", "implemented"]]));
	assert.ok(errors.some((error) => error.includes("duplicate")));
	assert.ok(errors.some((error) => error.includes("missing")));
	assert.ok(errors.some((error) => error.includes("extra")));
	assert.ok(errors.some((error) => error.includes("invalid")));
	assert.ok(errors.some((error) => error.includes("status mismatch")));
	assert.ok(errors.some((error) => error.includes("claimed global")));
});
