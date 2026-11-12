import { readFile } from "node:fs/promises";

import {
	compileTypeScriptSources,
	type TypeScriptDiagnostic,
} from "./typescript.js";

export async function compileWorkerEventFixture(
	declarationsPath: string,
	fixturePath: string,
): Promise<TypeScriptDiagnostic[]> {
	const [declarations, fixture] = await Promise.all([
		readFile(declarationsPath, "utf8"),
		readFile(fixturePath, "utf8"),
	]);
	return compileTypeScriptSources([
		{
			fileName: "/__open_orange_events__/cloudflare-runtime.d.ts",
			source: declarations,
		},
		{
			fileName: "/__open_orange_events__/worker.ts",
			source: fixture,
		},
	]);
}
