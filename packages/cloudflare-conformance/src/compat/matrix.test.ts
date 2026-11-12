import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { packageRoot } from "../commands/generate.js";
import type { RunSnapshot } from "../results/save.js";
import { readCompatMatrix, validateCompatMatrix } from "./matrix.js";

const repositoryRoot = join(packageRoot, "../..");

test("compat/matrix.json is valid and its evidence points at real file lines and saved tests", async () => {
	const latest = JSON.parse(
		await readFile(join(packageRoot, "results/latest.json"), "utf8"),
	) as RunSnapshot;
	const testIds = new Set(
		latest.tests.map((row) => `${row.file} > ${row.test}`),
	);

	const matrix = await readCompatMatrix(
		join(packageRoot, "compat/matrix.json"),
		repositoryRoot,
		testIds,
	);
	assert.ok(matrix.entries.length > 0);

	const packageJsonLines = (
		await readFile(join(repositoryRoot, "package.json"), "utf8")
	).split("\n").length;
	// The same check rejects an entry with a bad status, a missing file, lines past the end of
	// a file, and an unknown test.
	const { problems } = validateCompatMatrix(
		{
			schemaVersion: 1,
			entries: [
				{
					id: "broken",
					category: "sql",
					name: "x",
					status: "mostly",
					cloudflare: "x",
					orange: "x",
					notes: "x",
					evidence: [
						{ kind: "code", path: "does/not/exist.ts" },
						{ kind: "code", path: "package.json", lines: "1-99999" },
						{ kind: "test", file: "synthetic--do-sql-test", test: "noSuchTest" },
					],
				},
			],
		},
		repositoryRoot,
		testIds,
	);
	assert.deepEqual(problems, [
		"broken: unknown status mostly",
		"broken: evidence names missing file does/not/exist.ts",
		`broken: evidence names lines 1-99999 outside package.json (${packageJsonLines} lines)`,
		"broken: evidence names synthetic--do-sql-test > noSuchTest, which is not in the saved results",
	]);
});
