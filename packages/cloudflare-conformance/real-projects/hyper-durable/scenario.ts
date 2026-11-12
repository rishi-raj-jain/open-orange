import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const post = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

const specialDuck = {
	favoriteFoods: ["herring", "shrimp"],
	greeting: "Hello world, my name is Special Duck, and I have 2 favorite foods.",
};

const scenario: Scenario = async (t) => {
	const assertSpecialDuck = async () => {
		const duck = await t.json<typeof specialDuck>("/firstDuck");
		assert.deepEqual({ ...duck, favoriteFoods: [...duck.favoriteFoods].sort() }, specialDuck);
	};

	await t.step("a new duck reads the defaults set in its constructor, through a method and a property", "do-state", async () => {
		assert.deepEqual(await t.json("/firstDuck"), {
			favoriteFoods: [],
			greeting: "Hello world, my name is New Duck, and I have 0 favorite foods.",
		});
	});

	await t.step("the README's `await stub.name` reads the object's name property", "do-state", async () => {
		assert.deepEqual(await t.json("/firstDuck/name-only"), { name: "New Duck" });
	});

	await t.step("a setter and concurrent method calls persist, and another request reads them", "do-state", async () => {
		assert.deepEqual(await t.json("/firstDuck/name", post({ name: "Special Duck" })), { name: "Special Duck" });
		await t.json("/firstDuck/foods", post({ foods: ["herring", "shrimp"] }));
		await assertSpecialDuck();
	});

	await t.step("another duck has its own state, and a missing property throws a HyperError", "do-state", async () => {
		assert.deepEqual(await t.json("/secondDuck"), {
			favoriteFoods: [],
			greeting: "Hello world, my name is New Duck, and I have 0 favorite foods.",
		});
		const failed = await t.json("/firstDuck/beak", undefined, 500);
		assert.equal(failed.error, "Property beak does not exist");
	});

	await t.step("the persisted properties load back after the object sleeps", "sleep", async () => {
		await t.waitForSleep();
		await assertSpecialDuck();
	});

	await t.step("the persisted properties load back after an orange dev and engine restart", "restart", async () => {
		await t.restart();
		await assertSpecialDuck();
	});

	await t.step("destroy removes the data, and after a sleep the duck has its defaults again", "sleep", async () => {
		assert.deepEqual(await t.json("/firstDuck/destroy", post({})), { destroyed: null });
		const failed = await t.json("/firstDuck/foods-only", undefined, 500);
		assert.equal(failed.error, "Property favoriteFoods does not exist");
		await t.waitForSleep();
		assert.deepEqual(await t.json("/firstDuck"), {
			favoriteFoods: [],
			greeting: "Hello world, my name is New Duck, and I have 0 favorite foods.",
		});
	});
};

export default scenario;
