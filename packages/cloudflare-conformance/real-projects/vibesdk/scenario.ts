import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const scenario: Scenario = async (t) => {
	const jar = new Map<string, string>();
	// The Worker refuses a request whose hostname is an IP address, and `t.fetch` always uses one.
	const host = () => `localhost:${new URL(t.origin).port}`;
	const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
	const send = async (path: string, init: RequestInit = {}) => {
		const response = await fetch(`http://${host()}${path}`, {
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
			...init,
			headers: {
				cookie: cookie(),
				"content-type": "application/json",
				...(init.headers as Record<string, string>),
			},
		});
		for (const line of response.headers.getSetCookie()) {
			const [pair] = line.split(";");
			const index = pair!.indexOf("=");
			jar.set(pair!.slice(0, index), pair!.slice(index + 1));
		}
		return response;
	};
	// The app's api client: fetch a CSRF token, then send it with each write.
	const mutate = async (path: string, body: unknown) => {
		const token = (await (await send("/api/auth/csrf-token")).json()) as { data: { token: string } };
		return await send(path, {
			method: "POST",
			headers: { "x-csrf-token": token.data.token },
			body: JSON.stringify(body),
		});
	};
	const read = async <T = any>(path: string): Promise<T> => {
		const response = await send(path);
		const text = await response.text();
		assert.equal(response.status, 200, text.slice(0, 300));
		return (JSON.parse(text) as { data: T }).data;
	};
	const createApp = () => mutate("/api/agent", { query: "Build a small to-do list app" });
	const assertLimitKept = async () => {
		assert.equal((await read("/api/auth/profile")).user.email, "corpus@example.com");
		const refused = await createApp();
		const body = await refused.text();
		assert.equal(refused.status, 429, body.slice(0, 300));
		assert.match(body, /App creation rate limit exceeded/);
	};

	await t.step("the app page and the platform status are served", "http", async () => {
		assert.match(await (await send("/")).text(), /<div id="root"/);
		assert.ok(await read("/api/status"));
	});

	await t.step("a user registers with email, and D1 and the session cookie recognize them", "binding", async () => {
		const registered = await mutate("/api/auth/register", {
			email: "corpus@example.com",
			password: "CorpusLocal1234",
			name: "Corpus",
		});
		assert.equal(registered.status, 200, (await registered.clone().text()).slice(0, 300));
		assert.equal((await read("/api/auth/profile")).user.email, "corpus@example.com");
		assert.equal((await send("/api/apps/public")).status, 200);
	});

	await t.step("DORateLimitStore counts app creations, and the fourth in a day is refused", "do-state", async () => {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const response = await createApp();
			assert.notEqual(response.status, 429, `attempt ${attempt + 1} was refused`);
			await response.body?.cancel();
		}
		await assertLimitKept();
	});

	await t.step("the count and the sign-in survive the object's sleep", "sleep", async () => {
		// This 403 touches no object. It tells `waitForSleep` when the client was last active.
		await t.fetch("/");
		await t.waitForSleep();
		await assertLimitKept();
	});

	await t.step("the count and the sign-in survive a restart", "restart", async () => {
		await t.restart();
		await assertLimitKept();
	});

	t.needsSecrets("the agent builds an app from a prompt through ThinkAgent and SpaceDO", "websocket", [
		"CLOUDFLARE_AI_GATEWAY_TOKEN",
		"ANTHROPIC_API_KEY",
	]);
};

export default scenario;
