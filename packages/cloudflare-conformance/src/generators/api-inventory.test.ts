import assert from "node:assert/strict";
import test from "node:test";

import { createApiInventory } from "./api-inventory.js";

test("extracts declarations, members, modules, and stable hashes", () => {
	const inventory = createApiInventory(`
		declare class Example {
			static version: string;
			value?: number;
			read(): string;
		}

		declare module "cloudflare:test" {
			export function run(value: string): Promise<void>;
			export function run(value: number): Promise<void>;
		}
	`);

	assert.deepEqual(inventory.moduleSpecifiers, ["cloudflare:test"]);
	const example = inventory.declarations.find(
		(declaration) => declaration.kind === "class" && declaration.name === "Example",
	);
	assert.ok(example);
	assert.deepEqual(
		(example.members ?? []).map((member) => ({
			name: member.name,
			optional: member.optional ?? false,
			static: member.static ?? false,
		})),
		[
			{ name: "read", optional: false, static: false },
			{ name: "value", optional: true, static: false },
			{ name: "version", optional: false, static: true },
		],
	);

	const run = inventory.declarations.find(
		(declaration) =>
			declaration.moduleSpecifier === "cloudflare:test" &&
			declaration.kind === "function" &&
			declaration.name === "run",
	);
	assert.ok(run);
	assert.equal(run.exported, true);
	assert.equal(run.signatureHashes.length, 2);
	assert.ok(
		inventory.declarations.every((declaration) =>
			declaration.signatureHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)),
		),
	);
});
