import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { compileTypeScriptSources } from "./typescript.js";

interface ExpectedFixture {
	coverage: "excluded" | "included";
	expectation: "partial" | "unsupported";
	id: string;
}

const expectedFixtures: readonly ExpectedFixture[] = [
	{ coverage: "included", expectation: "partial", id: "included" },
	{ coverage: "excluded", expectation: "unsupported", id: "excluded" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function checkDurableObjectFixtures(
	packageRoot: string,
	declarationsPath: string,
): Promise<string[]> {
	const declarations = await readFile(declarationsPath, "utf8");
	const errors: string[] = [];
	for (const expected of expectedFixtures) {
		const directory = join(packageRoot, "fixtures", "durable-objects", expected.id);
		let manifest: unknown;
		try {
			manifest = JSON.parse(await readFile(join(directory, "fixture.json"), "utf8"));
		} catch (error: unknown) {
			errors.push(
				`${expected.id} Durable Object fixture manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		if (
			!isRecord(manifest) ||
			manifest.coverage !== expected.coverage ||
			manifest.expectation !== expected.expectation ||
			manifest.source !== "worker.ts"
		) {
			errors.push(
				`${expected.id} Durable Object fixture manifest must remain ${expected.coverage}/${expected.expectation}`,
			);
			continue;
		}
		const source = await readFile(join(directory, manifest.source), "utf8");
		for (const diagnostic of compileTypeScriptSources([
			{
				fileName: `/__open_orange_durable_objects__/${expected.id}/cloudflare-runtime.d.ts`,
				source: declarations,
			},
			{
				fileName: `/__open_orange_durable_objects__/${expected.id}/worker.ts`,
				source,
			},
		])) {
			errors.push(
				`${expected.id} Durable Object fixture is invalid against Cloudflare (TS${diagnostic.code}): ${diagnostic.message}`,
			);
		}
	}
	return errors;
}
