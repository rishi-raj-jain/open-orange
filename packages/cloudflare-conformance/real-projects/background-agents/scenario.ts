import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

const secret = "local-only-slack-bot-secret";

// buildServiceAuthHeaders of packages/shared/src/service-auth.ts: the sig1 format the Slack bot signs with.
function signed(method: string, path: string, actor: string, body = ""): Record<string, string> {
	const url = new URL(path, "http://control-plane");
	const timestampMs = Date.now();
	const nonce = randomBytes(8).toString("hex");
	const query = [...url.searchParams.entries()]
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.sort()
		.join("&");
	const bodyHash = createHash("sha256").update(body).digest("hex");
	const canonical = `sig1\nslack-bot\n${timestampMs}\n${nonce}\n${method}\n${url.pathname}\n${query}\n${bodyHash}\n${actor}`;
	const signature = createHmac("sha256", secret).update(canonical).digest("hex");
	return {
		"X-OpenInspect-Service": "slack-bot",
		"X-OpenInspect-Service-Signature": `sig1.${timestampMs}.${nonce}.${signature}`,
		"X-OpenInspect-Actor": actor,
		...(body === "" ? {} : { "Content-Type": "application/json" }),
	};
}

const scenario: Scenario = async (t) => {
	const actor = "slack:U0ADA";
	const call = async <T>(method: string, path: string, body?: unknown, status?: number): Promise<T> => {
		const text = body === undefined ? "" : JSON.stringify(body);
		return t.json<T>(
			path,
			{ method, headers: signed(method, path, actor, text), ...(text === "" ? {} : { body: text }) },
			status,
		);
	};
	const subscribe = async (id: string): Promise<{ socket: TestSocket; subscribed: Record<string, unknown> }> => {
		const { token } = await call<{ token: string }>("POST", `/sessions/${id}/ws-token`, {});
		const socket = await t.webSocket(`/sessions/${id}/ws`);
		socket.send(JSON.stringify({ type: "subscribe", token, clientId: `scenario-${Date.now()}` }));
		const text = await socket.until((message) => (JSON.parse(message) as { type: string }).type === "subscribed");
		return { socket, subscribed: JSON.parse(text) as Record<string, unknown> };
	};

	const titleOf = (subscribed: Record<string, unknown>) => (subscribed.session as { title?: string } | undefined)?.title;

	let id = "";

	await t.step("an unsigned request is refused, and a Slack actor enrolls", "http", async () => {
		await t.json("/sessions", undefined, 401);
		const path = "/actors/me";
		const body = JSON.stringify({ email: "ada@example.com" });
		const response = await t.fetch(path, { method: "POST", headers: signed("POST", path, actor, body), body });
		assert.equal(response.status, 204, await response.clone().text());
	});

	await t.step("a session is created, indexed in D1, and kept in its object", "do-state", async () => {
		const created = await call<{ sessionId: string }>("POST", "/sessions", { title: "Fix the flaky test" }, 201);
		id = created.sessionId;
		assert.ok(id);
		await assert.rejects(t.webSocket("/sessions/no-such-session/ws"), /HTTP 404/);
		const { socket, subscribed } = await subscribe(id);
		assert.equal(titleOf(subscribed), "Fix the flaky test");
		await socket.close();
	});

	await t.step("a client answers to ping over its socket, and a bad token is refused", "websocket", async () => {
		const { socket } = await subscribe(id);
		socket.send(JSON.stringify({ type: "ping" }));
		await socket.until((message) => (JSON.parse(message) as { type: string }).type === "pong");
		await socket.close();
		const bad = await t.webSocket(`/sessions/${id}/ws`);
		bad.send(JSON.stringify({ type: "subscribe", token: "not-a-token", clientId: "bad" }));
		await assert.rejects(
			bad.until((message) => (JSON.parse(message) as { type: string }).type === "subscribed", 10_000),
		);
		await bad.close();
	});

	await t.step("a subscribed client stays connected while the session hibernates", "sleep", async () => {
		await t.waitForSleep();
		const { socket } = await subscribe(id);
		await t.waitForSleep();
		// D1 is an actor too, and waitForSleep returns on any actor's sleep. Let the session's own timer end.
		await t.delay(3_000);
		socket.send(JSON.stringify({ type: "ping" }));
		await socket.until((message) => (JSON.parse(message) as { type: string }).type === "pong");
		await socket.close();
	});

	await t.step("the session comes back from its object after a sleep", "sleep", async () => {
		await t.waitForSleep();
		await t.delay(3_000);
		const { socket, subscribed } = await subscribe(id);
		assert.equal(titleOf(subscribed), "Fix the flaky test");
		await socket.close();
	});

	await t.step("the session survives an orange dev and engine restart", "restart", async () => {
		await t.restart();
		const { socket, subscribed } = await subscribe(id);
		assert.equal(titleOf(subscribed), "Fix the flaky test");
		await socket.close();
	});

	t.needsSecrets("a prompt runs in a sandbox", "binding", ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "ANTHROPIC_API_KEY"]);
};

export default scenario;
