import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const wikiIds = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

interface Wiki {
	wikiId: string;
	name: string;
	createdAtMs: number;
}

const scenario: Scenario = async (t) => {
	const assertAllWikis = async () => {
		const { wikis } = await t.json<{ wikis: Wiki[] }>("/wikis");
		assert.deepEqual(wikis.map((wiki) => wiki.wikiId).sort(), wikiIds);
		for (const wiki of wikis) {
			assert.equal(wiki.name, `wiki ${wiki.wikiId}`);
			// The column comes from the second migration.
			assert.equal(typeof wiki.createdAtMs, "number");
		}
	};

	await t.step("StaticShardedDO spreads writes over shards, and all() reads each one back", "do-state", async () => {
		const shards = new Set<number>();
		for (const wikiId of wikiIds) {
			const { shard } = await t.json<{ shard: number }>(`/wikis/${wikiId}`, {
				method: "POST",
				body: JSON.stringify({ name: `wiki ${wikiId}` }),
			});
			shards.add(shard);
		}
		assert.ok(shards.size > 1, `all writes went to shards ${[...shards].join(",")}`);
		await assertAllWikis();
	});

	await t.step("SQLSchemaMigrations records the last migration in each shard's storage", "do-state", async () => {
		assert.deepEqual(await t.json("/migrations"), { lastIds: [2, 2, 2, 2, 2] });
	});

	await t.step("tryAll keeps a failure in its shard, and all() throws the first error", "do-state", async () => {
		const { results } = await t.json<{ results: { shard: number; result?: string; error?: string }[] }>("/try-all");
		assert.equal(results.length, 5);
		for (const { shard, result, error } of results) {
			if (shard % 2 === 0) assert.match(error ?? "", new RegExp(`shard ${shard} failed`));
			else assert.equal(result, `shard ${shard} ok`);
		}
		const { thrown } = await t.json<{ thrown: string | null }>("/all-fails");
		assert.match(thrown ?? "", /shard \d failed/);
	});

	await t.step("tryN retries a failing object call until it succeeds", "do-state", async () => {
		assert.deepEqual(await t.json("/flaky"), { attempts: 3, calls: 3 });
	});

	await t.step("wikis and migration state survive a sleep, and the ALTER TABLE does not run again", "sleep", async () => {
		await t.waitForSleep();
		await assertAllWikis();
		assert.deepEqual(await t.json("/migrations"), { lastIds: [2, 2, 2, 2, 2] });
		assert.deepEqual(await t.json("/flaky"), { attempts: 1, calls: 4 });
	});

	await t.step("wikis and migration state survive an orange dev and engine restart", "restart", async () => {
		await t.restart();
		await assertAllWikis();
		assert.deepEqual(await t.json("/migrations"), { lastIds: [2, 2, 2, 2, 2] });
		assert.deepEqual(await t.json("/flaky"), { attempts: 1, calls: 5 });
	});

	await t.step("RegionPlacer runs a Worker method through a placed object, by both of its routes", "do-state", async () => {
		assert.equal(await t.text("/region-placer/autoinfer?hint=weur"), "ping:boomer @ weur");
		assert.equal(await t.text("/region-placer/auxiliary?hint=apac"), "ping:boomer @ apac");
	});
};

export default scenario;
