import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const scenario: Scenario = async (t) => {
	await t.step("the MCP endpoint asks an anonymous client to authorize", "http", async () => {
		const response = await t.fetch("/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		assert.equal(response.status, 401);
		assert.match(response.headers.get("www-authenticate") ?? "", /Bearer/);
	});

	const redirect = "http://localhost:9999/callback";
	const exchange = (clientId: string) =>
		t.fetch("/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: clientId,
				code: "not-a-code",
				redirect_uri: redirect,
				code_verifier: "x".repeat(43),
			}),
		});
	let clientId = "";

	await t.step("the OAuth metadata points a client at registration", "http", async () => {
		const metadata = await t.json<{ registration_endpoint: string }>("/.well-known/oauth-authorization-server");
		assert.match(metadata.registration_endpoint, /\/register$/);
	});

	await t.step("a registered client is known to the token endpoint, and a stranger is not", "binding", async () => {
		const client = await t.json<{ client_id: string }>(
			"/register",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ client_name: "scenario", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
			},
			201,
		);
		clientId = client.client_id;
		assert.equal(((await (await exchange(clientId)).json()) as { error: string }).error, "invalid_grant");
		assert.equal(((await (await exchange("stranger")).json()) as { error: string }).error, "invalid_client");
	});

	await t.step("the registered client survives a restart", "binding", async () => {
		await t.restart();
		assert.equal(((await (await exchange(clientId)).json()) as { error: string }).error, "invalid_grant");
	});

	t.needsSecrets("the DEX tools read a remote capture through WarpDiagReader", "do-state", [
		"CLOUDFLARE_CLIENT_ID",
		"CLOUDFLARE_CLIENT_SECRET",
	]);
};

export default scenario;
