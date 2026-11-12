import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

interface Auth {
	user: { email: string };
	token: string;
	refreshToken: string;
}

const scenario: Scenario = async (t) => {
	const json = { "Content-Type": "application/json" };
	const auth = (path: "signup" | "login", email: string, password: string, status?: number) =>
		t.json<Auth>(`/api/${path}`, { method: "POST", headers: json, body: JSON.stringify({ email, password }) }, status);
	const signedIn = (session: Auth) => ({ Cookie: `token=${session.token}; refreshToken=${session.refreshToken}` });
	const isEvent = (event: string) => (text: string) => (JSON.parse(text) as { event: string }).event === event;

	await t.step("a socket stays open while the user's object hibernates, and a message wakes it", "sleep", async () => {
		// First step of the run, with one user: waitForSleep returns on any actor's sleep.
		const session = await auth("signup", "sleeper@example.com", "correct horse");
		const socket = await t.webSocket("/api/ws", { headers: signedIn(session) });
		await socket.until(isEvent("connected"));
		await t.waitForSleep();
		socket.send(JSON.stringify({ hello: "again" }));
		const echo = JSON.parse(await socket.until(isEvent("echo"))) as { original: unknown };
		assert.deepEqual(echo.original, { hello: "again" });
		await socket.close();
	});

	let ada: Auth | undefined;
	await t.step("signup and login keep the account, and refuse bad credentials", "do-state", async () => {
		await t.waitForSleep();
		ada = await auth("signup", "ada@example.com", "correct horse");
		assert.equal(ada.user.email, "ada@example.com");
		const duplicate = await auth("signup", "ada@example.com", "another one", 400);
		assert.ok("error" in duplicate);
		const wrong = await auth("login", "ada@example.com", "wrong password", 400);
		assert.ok("error" in wrong);
		ada = await auth("login", "ada@example.com", "correct horse");
		const me = await t.json<{ user: { email: string } }>("/api/me", { headers: signedIn(ada) });
		assert.equal(me.user.email, "ada@example.com");
		await t.json("/posts", undefined, 401);
	});

	await t.step("key-value data and posts persist per user, with no leak to another user", "do-state", async () => {
		assert.ok(ada !== undefined);
		await t.json("/data", {
			method: "POST",
			headers: { ...json, ...signedIn(ada) },
			body: JSON.stringify({ key: "data", value: { theme: "dark" } }),
		});
		const data = await t.json<{ data: unknown }>("/data", { headers: signedIn(ada) });
		assert.deepEqual(data.data, { theme: "dark" });
		const created = await t.json<{ data: { id: string } }>("/api/posts", {
			method: "POST",
			headers: { ...json, ...signedIn(ada) },
			body: JSON.stringify({ title: "First", content: "Body one" }),
		});
		await t.json("/api/posts", {
			method: "POST",
			headers: { ...json, ...signedIn(ada) },
			body: JSON.stringify({ title: "Second", content: "Body two" }),
		});
		const doomed = await t.json<{ data: { id: string } }>("/api/posts", {
			method: "POST",
			headers: { ...json, ...signedIn(ada) },
			body: JSON.stringify({ title: "Doomed", content: "Gone soon" }),
		});
		assert.ok(created.data.id);
		await t.json(`/posts/${doomed.data.id}`, { method: "DELETE", headers: signedIn(ada) });
		const posts = await t.json<{ posts: { title: string }[] }>("/posts", { headers: signedIn(ada) });
		assert.deepEqual(posts.posts.map((post) => post.title).sort(), ["First", "Second"]);
		const grace = await auth("signup", "grace@example.com", "battery staple");
		const other = await t.json<{ posts: unknown[] }>("/posts", { headers: signedIn(grace) });
		assert.deepEqual(other.posts, []);
	});

	await t.step("a new post reaches the user's open socket", "websocket", async () => {
		assert.ok(ada !== undefined);
		const socket = await t.webSocket("/api/ws", { headers: signedIn(ada) });
		await socket.until(isEvent("connected"));
		socket.send(JSON.stringify({ ping: 1 }));
		await socket.until(isEvent("echo"));
		await t.json("/api/posts", {
			method: "POST",
			headers: { ...json, ...signedIn(ada) },
			body: JSON.stringify({ title: "Live", content: "Over the socket" }),
		});
		// The table broadcasts { type }, then the example's route broadcasts { action }.
		const fromTable = JSON.parse(await socket.until(isEvent("table:posts"))) as {
			data: { type: string; data: { title: string } };
		};
		assert.deepEqual([fromTable.data.type, fromTable.data.data.title], ["create", "Live"]);
		const fromRoute = JSON.parse(await socket.until(isEvent("table:posts"))) as {
			data: { action: string; data: { title: string } };
		};
		assert.deepEqual([fromRoute.data.action, fromRoute.data.data.title], ["create", "Live"]);
		await socket.close();
	});

	await t.step("data and posts survive the object's sleep", "sleep", async () => {
		assert.ok(ada !== undefined);
		await t.waitForSleep();
		const posts = await t.json<{ posts: { title: string }[] }>("/posts", { headers: signedIn(ada) });
		assert.deepEqual(posts.posts.map((post) => post.title).sort(), ["First", "Live", "Second"]);
		const data = await t.json<{ data: unknown }>("/data", { headers: signedIn(ada) });
		assert.deepEqual(data.data, { theme: "dark" });
	});

	await t.step("the account, data, and posts survive an orange dev and engine restart", "restart", async () => {
		await t.restart();
		const session = await auth("login", "ada@example.com", "correct horse");
		const posts = await t.json<{ posts: { title: string }[] }>("/posts", { headers: signedIn(session) });
		assert.deepEqual(posts.posts.map((post) => post.title).sort(), ["First", "Live", "Second"]);
		const data = await t.json<{ data: unknown }>("/data", { headers: signedIn(session) });
		assert.deepEqual(data.data, { theme: "dark" });
	});
};

export default scenario;
