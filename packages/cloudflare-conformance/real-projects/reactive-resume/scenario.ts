import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const scenario: Scenario = async (t) => {
	const signIn = () =>
		t.fetch("/api/auth/sign-in/email", {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://localhost:8787" },
			body: JSON.stringify({ email: "nobody@example.com", password: "not-the-password" }),
		});

	await t.step("the public routes that need no database are served", "http", async () => {
		assert.match(await t.text("/robots.txt"), /User-agent/i);
		await t.json("/schema.json");
	});

	await t.step("the sixth sign-in in a minute is refused by the Coordination limit", "do-state", async () => {
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 6; attempt += 1) statuses.push((await signIn()).status);
		assert.equal(statuses[5], 429, `statuses: ${statuses.join(", ")}`);
		assert.equal(statuses.slice(0, 5).includes(429), false, `statuses: ${statuses.join(", ")}`);
	});

	await t.step("the limit is still in force after the object sleeps", "sleep", async () => {
		await t.waitForSleep();
		assert.equal((await signIn()).status, 429);
	});

	await t.step("the limit is still in force after a restart", "restart", async () => {
		await t.restart();
		assert.equal((await signIn()).status, 429);
	});

	await t.step("an account signs up and gets a session from PostgreSQL through Hyperdrive", "binding", async () => {
		const response = await t.fetch("/api/auth/sign-up/email", {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://localhost:8787" },
			body: JSON.stringify({ name: "Ada", username: "ada", displayUsername: "ada", email: "ada@example.com", password: "correct-horse-battery" }),
		});
		assert.equal(response.status, 200, (await response.text()).slice(0, 300));
	});
};

export default scenario;
