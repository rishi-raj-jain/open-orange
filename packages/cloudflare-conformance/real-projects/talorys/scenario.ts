import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const password = "corpus-Local-owner-1234";

/** A wall time in the owner's zone, at least `minutes` ahead, as the schedule form sends it. */
function wallTime(timezone: string, minutes: number): { at: string; dueAt: number } {
	const dueAt = (Math.ceil(Date.now() / 60_000) + minutes) * 60_000;
	const text = new Date(dueAt).toLocaleString("sv-SE", { timeZone: timezone, hour12: false });
	return { at: text.slice(0, 16).replace(" ", "T"), dueAt };
}

const scenario: Scenario = async (t) => {
	let cookie = "";
	const headers = () => ({ cookie, "content-type": "application/json", "x-talorys-request": "1" });
	const api = <T = any>(path: string, init: RequestInit = {}, status = 200) =>
		t.json<T>(`/api${path}`, { ...init, headers: headers() }, status);
	const post = <T = any>(path: string, body: unknown, status = 200) =>
		api<T>(path, { method: "POST", body: JSON.stringify(body) }, status);
	const remind = async (name: string, minutes: number) => {
		const { timezone } = await api("/automations");
		const { at, dueAt } = wallTime(timezone, minutes);
		await post("/automations", { name, kind: "reminder", message: `${name} now`, schedule: { type: "once", at } }, 201);
		return dueAt;
	};
	const assertKept = async () => {
		const tasks = await api("/tasks");
		const titles = tasks.tasks.map((task: { title: string }) => task.title);
		assert.ok(titles.includes("Review the budget"), titles.join());
		assert.ok(titles.includes("buy milk"), titles.join());
		const notes = await api("/notes");
		assert.equal(notes.notes[0].title, "Trip ideas");
		const memories = await api("/memories");
		assert.match(JSON.stringify(memories), /I prefer tea/);
		const { conversations } = await api("/conversations");
		assert.equal(conversations.length, 1);
	};

	await t.step("the web app is served, and the owner signs in", "http", async () => {
		assert.match(await t.text("/"), /<div id="root"/);
		const health = await t.json("/api/health");
		assert.equal(health.storage, "ok");
		await t.json(
			"/api/auth/login",
			{ method: "POST", headers: headers(), body: JSON.stringify({ password: "wrong-password-1234" }) },
			401,
		);
		await t.json("/api/tasks", undefined, 401);
		const login = await t.fetch("/api/auth/login", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ password }),
		});
		assert.equal(login.status, 200, await login.clone().text());
		cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
		assert.equal((await api("/auth/session")).authenticated, true);
	});

	await t.step("tasks, notes, and memories are written and read back", "do-state", async () => {
		const created = await post("/tasks", { title: "Review the budget", priority: "high" }, 201);
		await api(`/tasks/${created.task.id}`, { method: "PATCH", body: JSON.stringify({ status: "in_progress" }) });
		assert.equal((await api(`/tasks/${created.task.id}`)).task.status, "in_progress");
		await post("/notes", { title: "Trip ideas", content: "Kyoto" }, 201);
		await post("/memories", { content: "I prefer tea", category: "preference" }, 201);
		assert.match(JSON.stringify(await api("/memories?q=tea")), /I prefer tea/);
	});

	await t.step("a chat turn streams through the object, and its tool writes a task", "do-state", async () => {
		const response = await t.fetch("/api/chat", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ message: "add a task to buy milk" }),
		});
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
		const stream = await response.text();
		assert.match(stream, /event: start/);
		assert.match(stream, /event: tool/);
		assert.match(stream, /event: done/);
		assert.match(stream, /Added the task/);
		const { tasks } = await api("/tasks");
		assert.ok(tasks.some((task: { title: string }) => task.title === "buy milk"));
	});

	await t.step("a reminder fires from an alarm while the object sleeps", "alarm", async () => {
		const dueAt = await remind("Stretch", 2);
		await t.waitForSleep();
		await t.delay(Math.max(0, dueAt - Date.now()) + 10_000);
		const { notifications } = await api("/notifications");
		assert.match(JSON.stringify(notifications), /Stretch now/);
	});

	await t.step("the data survives the object's sleep", "sleep", async () => {
		await t.waitForSleep();
		await assertKept();
	});

	let afterRestartDue = 0;
	await t.step("the data and the session survive a restart", "restart", async () => {
		afterRestartDue = await remind("Hydrate", 2);
		await t.restart();
		await assertKept();
	});

	await t.step("a reminder set before a restart still fires after it", "alarm", async () => {
		await t.delay(Math.max(0, afterRestartDue - Date.now()) + 10_000);
		const { notifications } = await api("/notifications");
		assert.match(JSON.stringify(notifications), /Hydrate now/);
	});

	t.needsSecrets("a chat turn with real Workers AI", "binding", ["OPENROUTER_API_KEY"]);
};

export default scenario;
