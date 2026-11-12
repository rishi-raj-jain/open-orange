import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const MiB = 1024 * 1024;

// Each step goes past a platform limit that `wrangler dev` does not enforce, so this probe has no baseline.
// A DO's Date.now() also stands still on workerd, so its timing loops would never end there.
const scenario: Scenario = async (t) => {
	const sized = async (path: string, field: string, expected: number) => {
		const body = await t.json(path);
		assert.equal(body.error, undefined);
		assert.equal(body[field], expected);
	};

	await t.step("a Worker whose global scope runs for 1.5 s starts", "http", async () => {
		assert.equal(await t.text("/ping"), "pong");
	});
	await t.step("a Durable Object runs 35 s of CPU in one request", "do-state", async () => {
		const response = await fetch(`${t.origin}/cpu?ms=35000`, { signal: AbortSignal.timeout(90_000) });
		const body = (await response.json()) as { spins: number };
		assert.ok(body.spins > 0);
	});
	await t.step("a Durable Object holds 512 MiB between requests", "do-state", async () => {
		await sized("/hold?mb=512", "heldMb", 512);
		const body = await t.json("/held");
		assert.deepEqual(body, { heldMb: 512, sample: 7 });
	});
	await t.step("one request makes 2,000 subrequests", "http", async () => {
		const response = await fetch(`${t.origin}/subrequests?count=2000`, { signal: AbortSignal.timeout(120_000) });
		assert.deepEqual(await response.json(), { ok: 2000 });
	});
	await t.step("a 600 MiB request body streams through", "http", async () => {
		const chunk = new Uint8Array(MiB);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent === 600) {
					controller.close();
					return;
				}
				sent++;
				controller.enqueue(chunk);
			},
		});
		const response = await fetch(`${t.origin}/upload`, {
			method: "POST",
			body,
			duplex: "half",
			signal: AbortSignal.timeout(120_000),
		} as RequestInit);
		assert.deepEqual(await response.json(), { bytes: 600 * MiB });
	});
};

export default scenario;
