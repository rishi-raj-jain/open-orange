import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkArtifactFreshness } from "./artifact-freshness.js";

test("reports missing and stale generated artifacts", async () => {
	const root = await mkdtemp(join(tmpdir(), "open-orange-freshness-test-"));
	const tracked = join(root, "tracked");
	const fresh = join(root, "fresh");
	await mkdir(tracked);
	await mkdir(fresh);

	try {
		await writeFile(join(tracked, "same"), "same");
		await writeFile(join(fresh, "same"), "same");
		await writeFile(join(tracked, "stale"), "old");
		await writeFile(join(fresh, "stale"), "new");
		await writeFile(join(fresh, "missing"), "new");

		assert.deepEqual(
			await checkArtifactFreshness(tracked, fresh, [
				"same",
				"stale",
				"missing",
			]),
			[
				"stale generated artifact: generated/stale",
				"missing generated artifact: generated/missing",
			],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
