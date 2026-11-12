import assert from "node:assert/strict";

import type { Scenario, ScenarioContext } from "../../src/real-projects/scenario.js";

// How many new actors a call starts. The unit of scale is what gets its own actor.
async function newActors(t: ScenarioContext, call: () => Promise<void>): Promise<number> {
	const before = new Set(t.actorIds());
	await call();
	// A Workflow's first step can start its actor after the call returns.
	await t.delay(750);
	return t.actorIds().filter((id) => !before.has(id)).length;
}

const scenario: Scenario = async (t) => {
	const get = async (path: string) => {
		await t.json(path);
	};

	const unit = async (
		name: string,
		kind: "do-state" | "binding",
		sameUnit: string,
		otherUnit: string,
		firstUnit: string,
	) => {
		await t.step(name, kind, async () => {
			assert.equal(await newActors(t, () => get(firstUnit)), 1, "the first use starts one actor");
			assert.equal(await newActors(t, () => get(sameUnit)), 0, "a second call to the same unit starts none");
			assert.equal(await newActors(t, () => get(otherUnit)), 1, "another unit starts its own actor");
		});
	};

	// The first call to anything also starts what the session needs once, so this one does not count.
	await get("/do/warm");
	await unit("Durable Objects: one actor per object id", "do-state", "/do/one", "/do/two", "/do/one");
	await unit("KV: one actor per namespace", "binding", "/kv/A", "/kv/B", "/kv/A");
	await unit("D1: one actor per database", "binding", "/d1/A", "/d1/B", "/d1/A");
	await unit("R2: one actor per bucket without S3", "binding", "/r2/A", "/r2/B", "/r2/A");
	await unit("Queues: one actor per queue", "binding", "/queue/A", "/queue/B", "/queue/A");
	await unit("Rate Limiting: one actor per namespace", "binding", "/limit/A", "/limit/B", "/limit/A");
	await unit("Cache: caches.default is one actor", "binding", "/cache-default/b", "/cache-named/other/a", "/cache-default/a");
	await unit("Cache: one actor per cache name", "binding", "/cache-named/first/b", "/cache-named/second/a", "/cache-named/first/c");
	await t.step("Workflows: one actor per instance", "binding", async () => {
		assert.ok((await newActors(t, () => get("/flow/one"))) >= 1, "an instance starts an actor");
		assert.ok((await newActors(t, () => get("/flow/two"))) >= 1, "another instance starts its own actor");
	});
};

export default scenario;
