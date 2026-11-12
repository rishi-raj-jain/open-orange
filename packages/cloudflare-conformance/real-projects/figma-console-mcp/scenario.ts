import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const scenario: Scenario = async (t) => {
	await t.step("serves the landing page and the health route", "http", async () => {
		assert.match(await t.text("/"), /Figma Console MCP/);
		const health = await t.json<{ status: string; oauth_configured: boolean }>("/health");
		assert.equal(health.status, "healthy");
		assert.equal(health.oauth_configured, false);
	});

	await t.step("an MCP client without a token gets 401 with the resource metadata", "http", async () => {
		const response = await t.fetch("/mcp", { method: "POST", body: "{}" });
		assert.equal(response.status, 401);
		const challenge = response.headers.get("www-authenticate") ?? "";
		const metadata = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
		assert.ok(metadata, `the challenge names the metadata: ${challenge}`);
		const resource = await t.json<{ resource: string }>(new URL(metadata).pathname);
		assert.equal(resource.resource, t.origin);
	});

	await t.step("an MCP client registers in KV, and /authorize checks its redirect URI against the record", "binding", async () => {
		const redirect = "https://client.example/callback";
		const authorize = (clientId: string, target: string) =>
			`/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(target)}&response_type=code&state=s&code_challenge=c&code_challenge_method=S256`;
		const client = await t.json<{ client_id: string }>(
			"/oauth/register",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ client_name: "scenario", redirect_uris: [redirect] }),
			},
			201,
		);
		const refused = await t.json<{ error_description: string }>(authorize(client.client_id, "https://other.example/callback"), undefined, 400);
		assert.equal(refused.error_description, "redirect_uri is not registered for this client_id");
		// A registered client passes the check and stops at the Figma OAuth app, which needs credentials.
		const accepted = await t.json<{ error_description: string }>(authorize(client.client_id, redirect), undefined, 500);
		assert.equal(accepted.error_description, "OAuth not configured on server");
	});

	await t.step("the plugin relay refuses a pairing code that was never issued", "http", async () => {
		await assert.rejects(t.webSocket("/ws/pair?code=NOPE00"), /HTTP 404/);
	});

	t.needsSecrets("an MCP session runs in FigmaConsoleMCPv3 and pairs a plugin through PluginRelayDO", "do-state", [
		"FIGMA_OAUTH_CLIENT_ID",
		"FIGMA_OAUTH_CLIENT_SECRET",
	]);
};

export default scenario;
