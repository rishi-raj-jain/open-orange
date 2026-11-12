import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const scenario: Scenario = async (t) => {
	await t.step("the worker migrates D1 on the first request and answers its health route", "binding", async () => {
		assert.deepEqual(await t.json("/health"), { ok: true });
	});

	await t.step("the setup page reports a ready database", "binding", async () => {
		const page = await t.text("/setup");
		assert.match(page, /Set up Company Brain/);
		assert.doesNotMatch(page, /waiting to run|Setting up the database failed/);
	});

	await t.step("a signed-out visitor gets a session answer from D1 and KV", "binding", async () => {
		assert.deepEqual(await t.json("/auth/session"), { user: null, org: null, role: null, setupComplete: false });
	});

	await t.step("the Slack app manifest lists the worker's Slack routes", "http", async () => {
		const manifest = await t.json<{ oauth_config: { redirect_urls: string[] } }>("/setup/manifest.json");
		assert.ok(
			manifest.oauth_config.redirect_urls.some((url) => url.endsWith("/brain/slack/oauth/callback")),
			"the manifest has the install callback",
		);
	});

	t.needsSecrets("a Slack event wakes CompanyBrainAgent, which runs a turn and answers", "do-state", [
		"SLACK_CLIENT_ID",
		"SLACK_CLIENT_SECRET",
		"SLACK_SIGNING_SECRET",
		"SUPERMEMORY_API_KEY",
		"MODEL_API_KEY",
	]);
};

export default scenario;
