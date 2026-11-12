import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const scenario: Scenario = async (t) => {
	await t.step("serves the server description and the OAuth resource metadata", "http", async () => {
		const about = await t.json<{ name: string }>("/");
		assert.equal(about.name, "supermemory-mcp");
		const metadata = await t.json<{ authorization_servers: string[] }>("/.well-known/oauth-protected-resource");
		assert.deepEqual(metadata.authorization_servers, ["https://api.supermemory.ai/api/auth"]);
	});

	await t.step("an MCP client without a token gets 401 with the resource metadata", "http", async () => {
		const response = await t.fetch("/mcp", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		assert.equal(response.status, 401);
		assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/);
	});

	await t.step("SpaceState refuses an upload token with no session", "do-state", async () => {
		const form = new FormData();
		form.set("file", new Blob(["hello"], { type: "text/plain" }), "hello.txt");
		const answer = await t.json<{ error: string }>(
			"/upload/0f0f0f0f-0000-4000-8000-000000000001",
			{ method: "POST", headers: { authorization: "Bearer no-such-session" }, body: form },
			401,
		);
		assert.equal(answer.error, "Invalid or expired upload session");
	});

	t.needsSecrets("the active space is stored in SpaceState and an upload session is consumed once", "do-state", [
		"SUPERMEMORY_OAUTH_ACCESS_TOKEN",
	]);
};

export default scenario;
