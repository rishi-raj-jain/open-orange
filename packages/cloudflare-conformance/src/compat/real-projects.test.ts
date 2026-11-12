import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { packageRoot } from "../commands/generate.js";
import { readRealProjectTable } from "./real-projects.js";

test("compat/real-projects.json loads, and a bad status or a missing blocker fails the report with the project name", async () => {
	const table = await readRealProjectTable(join(packageRoot, "compat/real-projects.json"));
	assert.ok(table.projects.length > 0);

	const path = join(await mkdtemp(join(tmpdir(), "real-projects-")), "real-projects.json");
	const works = { unchanged: "works", build: "works", probe: "works" };
	await writeFile(
		path,
		JSON.stringify({
			schemaVersion: 1,
			before: { date: "2026-10-20", orange: "aaaaaaa" },
			after: { date: "2026-10-21", orange: "bbbbbbb" },
			wrangler: "4.129.0",
			projects: [
				{
					project: "d1-template",
					url: "https://github.com/cloudflare/templates",
					flows: "GET /",
					before: works,
					after: { ...works, probe: "mostly" },
				},
				{
					project: "mcp",
					url: "https://github.com/cloudflare/agents",
					flows: "start",
					before: works,
					after: { ...works, build: "fails" },
				},
			],
		}),
	);
	await assert.rejects(readRealProjectTable(path), (error: Error) => {
		assert.match(
			error.message,
			/d1-template: after\.probe has unknown status mostly \(expected one of works, partial, fails, needs-step\)/,
		);
		assert.match(error.message, /mcp: blocker must say why an after result is not works/);
		return true;
	});
});
