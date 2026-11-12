import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWranglerHelpInventory } from "../generators/wrangler-help.js";
import { checkArtifactFreshness } from "./artifact-freshness.js";
import { compareHelpInventories } from "./help-parity.js";
import { findUnsafeTypeEscapes } from "./source-safety.js";
import { compileTypeScript } from "./typescript.js";

function assertTypeFailure(source: string): void {
	assert.notDeepEqual(compileTypeScript(source), []);
}

test("accepts an exact type-conformance control", () => {
	assert.deepEqual(
		compileTypeScript(`
			interface Expected { get(): Promise<string>; }
			declare const actual: Expected;
			const check: Expected = actual;
		`),
		[],
	);
});

test("rejects stale generated output", async () => {
	const root = await mkdtemp(join(tmpdir(), "open-orange-negative-test-"));
	const tracked = join(root, "tracked");
	const fresh = join(root, "fresh");
	await mkdir(tracked);
	await mkdir(fresh);
	try {
		await writeFile(join(tracked, "surface.json"), "old");
		await writeFile(join(fresh, "surface.json"), "new");
		assert.deepEqual(
			await checkArtifactFreshness(tracked, fresh, ["surface.json"]),
			["stale generated artifact: generated/surface.json"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects missing and incorrectly typed values", () => {
	assertTypeFailure(`
		interface ExpectedGlobals { atob(value: string): string; }
		declare const missing: {};
		const missingCheck: ExpectedGlobals = missing;
	`);
	assertTypeFailure(`
		interface ExpectedGlobals { atob(value: string): string; }
		declare const incorrect: { atob(value: string): number };
		const incorrectCheck: ExpectedGlobals = incorrect;
	`);
});

test("rejects extra module exports", () => {
	assertTypeFailure(`
		type SameKeys<Left, Right> =
			Exclude<keyof Left, keyof Right> extends never
				? Exclude<keyof Right, keyof Left> extends never ? true : false
				: false;
		type Assert<Condition extends true> = Condition;
		interface ExpectedModule { DurableObject: abstract new () => object; }
		declare const actual: ExpectedModule & { accidentalExport: string };
		type ModuleKeysCheck = Assert<SameKeys<typeof actual, ExpectedModule>>;
	`);
});

test("rejects invalid binding factory results", () => {
	assertTypeFailure(`
		interface SecretsStoreSecret { get(): Promise<string>; }
		declare function createBinding(): { get(): Promise<number> };
		const bindingCheck: SecretsStoreSecret = createBinding();
	`);
});

test("rejects missing, extra, and different CLI help", async () => {
	const reference = await createWranglerHelpInventory(
		async () => "wrangler\n\nReference help\n",
		"4.129.0",
	);
	const different = await createWranglerHelpInventory(
		async () => "wrangler\n\nDifferent help\n",
		"4.129.0",
	);
	const missing = { ...reference, commands: [] };
	const extra = {
		...reference,
		commands: [
			...reference.commands,
			{
				path: ["extra"],
				children: [],
				help: "wrangler extra\n",
				invocation: "wrangler extra",
			},
		],
	};

	assert.deepEqual(compareHelpInventories(reference, different, new Map()), [
		"different CLI help output: <root>",
	]);
	assert.deepEqual(compareHelpInventories(reference, missing, new Map()), [
		"missing CLI help endpoint: <root>",
	]);
	assert.deepEqual(compareHelpInventories(reference, extra, new Map()), [
		"extra CLI help endpoint: extra",
	]);
});

test("rejects unsafe TypeScript escape hatches including nested any", () => {
	const errors = findUnsafeTypeEscapes({
		path: "src/unsafe.ts",
		source: `
			type Nested = Map<string, any>;
			declare const value: unknown;
			const asserted = value as string;
			const present = asserted!;
			// @ts-ignore
			const ignored: number = "wrong";
			// @ts-nocheck
		`,
	});

	assert.ok(errors.some((error) => error.includes("unsafe any type")));
	assert.ok(errors.some((error) => error.includes("unsafe type assertion")));
	assert.ok(errors.some((error) => error.includes("unsafe non-null assertion")));
	assert.ok(errors.some((error) => error.includes("unsafe @ts-ignore")));
	assert.ok(errors.some((error) => error.includes("unsafe @ts-nocheck")));
	assert.deepEqual(
		findUnsafeTypeEscapes({
			path: "src/safe.ts",
			source: "const value = { status: 'partial' } as const;\n",
		}),
		[],
	);
});

test("accepts a type assertion only under a non-empty SAFETY comment", () => {
	const scan = (source: string): string[] =>
		findUnsafeTypeEscapes({ path: "src/cast.ts", source });

	assert.deepEqual(
		scan(`
			declare const value: unknown;
			// SAFETY: The caller validated the shape before this point.
			// TypeScript cannot carry that proof across the callback boundary.
			const justified = value as string;
			const nested = [
				// SAFETY: The array literal above only holds strings.
				value as string,
			];
		`),
		[],
	);
	assert.deepEqual(
		scan(`
			declare const value: unknown;
			const unjustified = value as string;
		`),
		[
			"src/cast.ts:3:24 uses unsafe type assertion without a `// SAFETY:` comment directly above",
		],
	);
	assert.equal(
		scan(`
			declare const value: unknown;
			// SAFETY:
			const empty = value as string;
		`).length,
		1,
	);
	assert.equal(
		scan(`
			declare const value: unknown;
			// The value is a string.
			// SAFETY: The comment block must start with the justification.
			const buried = value as string;
		`).length,
		1,
	);
	assert.equal(
		scan(`
			declare const value: unknown;
			// SAFETY: A blank line separates this comment from the cast.

			const detached = value as string;
		`).length,
		1,
	);
	assert.equal(
		scan(`
			declare const value: string | undefined;
			// SAFETY: A justification does not permit a non-null assertion.
			const present = value!;
			// SAFETY: A justification does not permit any.
			let loose: any;
		`).length,
		2,
	);
});

test("skips help text only for replaced commands and flags stale replacements", async () => {
	const reference = await createWranglerHelpInventory(
		async () => "wrangler\n\nReference help\n",
		"4.129.0",
	);
	const different = await createWranglerHelpInventory(
		async () => "wrangler\n\nDifferent help\n",
		"4.129.0",
	);

	assert.deepEqual(
		compareHelpInventories(reference, different, new Map([["", "Orange replaces it."]])),
		[],
	);
	assert.deepEqual(
		compareHelpInventories(reference, different, new Map([["dev", "Orange replaces it."]])),
		[
			"different CLI help output: <root>",
			"replaced CLI help command is not in Wrangler: dev",
		],
	);
});
