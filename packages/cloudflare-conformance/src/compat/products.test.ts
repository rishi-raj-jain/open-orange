import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { packageRoot } from "../commands/generate.js";
import { readProductTable } from "./products.js";

const repositoryRoot = join(packageRoot, "../..");

test("compat/products.json loads, and a bad status, missing evidence file, or pluggable product without configure fails the report with the product name", async () => {
	const table = await readProductTable(
		join(packageRoot, "compat/products.json"),
		repositoryRoot,
	);
	assert.ok(table.products.length > 0);

	const path = join(await mkdtemp(join(tmpdir(), "products-")), "products.json");
	await writeFile(
		path,
		JSON.stringify({
			schemaVersion: 1,
			products: [
				{
					product: "KV",
					orange: "x",
					status: "mostly",
					note: "x",
					evidence: ["does/not/exist.ts"],
				},
				{
					product: "R2",
					orange: "x",
					status: "pluggable",
					note: "x",
					evidence: ["docs/modules/r2.mdx"],
				},
			],
		}),
	);
	await assert.rejects(readProductTable(path, repositoryRoot), (error: Error) => {
		assert.match(error.message, /KV: unknown status mostly \(expected one of drop-in, pluggable, partial, stub, unsupported\)/);
		assert.match(error.message, /KV: evidence names missing file does\/not\/exist\.ts/);
		assert.match(error.message, /R2: configure must list the variables that pick the backend/);
		return true;
	});
});
