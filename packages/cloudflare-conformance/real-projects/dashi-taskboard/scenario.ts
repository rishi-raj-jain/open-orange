import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

// docs/cloud-collaboration.md: any actor name as the username, the shared secret as the password.
const authorization = `Basic ${Buffer.from("alice:local-only-shared-secret").toString("base64")}`;
const headers = { authorization, "content-type": "application/json" };
const settingsKey = "taskboard.project-board-display-settings.v3.alpha";

const scenario: Scenario = async (t) => {
	await t.step("the board page and API need the shared secret", "http", async () => {
		assert.deepEqual(await t.json("/health"), { status: "ok" });
		await t.text("/", {}, 401);
		assert.match(await t.text("/", { headers }), /<div id="root"/);
		const meta = await t.json<{ realtime: { transport: string; endpoint: string } }>("/api/meta", { headers });
		assert.deepEqual(meta.realtime, { transport: "websocket", endpoint: "/api/events" });
	});

	await t.step("an open board gets a revision through the hub when a task is created", "websocket", async () => {
		const board = await t.webSocket("/api/events", { headers: { authorization } });
		const { project } = await t.json<{ project: { id: string } }>(
			"/api/projects",
			{ method: "POST", headers, body: JSON.stringify({ id: "alpha", name: "Alpha" }) },
			201,
		);
		assert.equal(project.id, "alpha");
		const first = JSON.parse(await board.until((text) => text.includes('"type":"revision"')));
		const { task } = await t.json<{ task: { id: string; title: string } }>(
			"/api/tasks",
			{ method: "POST", headers, body: JSON.stringify({ projectId: "alpha", title: "Ship it" }) },
			201,
		);
		assert.equal(task.title, "Ship it");
		const second = JSON.parse(await board.until((text) => text.includes('"type":"revision"')));
		assert.ok(second.revision > first.revision, `revision ${second.revision} did not advance past ${first.revision}`);
		await board.close();
	});

	await t.step("board display settings are kept in the hub across requests, and null deletes them", "do-state", async () => {
		const write = (value: unknown) => t.text(
			"/api/client-storage",
			{ method: "PATCH", headers, body: JSON.stringify({ key: settingsKey, value }) },
			204,
		);
		await write('{"columns":["todo"]}');
		await write('{"columns":["todo","done"]}');
		await write(null);
		const read = () => t.json<{ entries: Record<string, unknown> }>("/api/client-storage", { headers });
		assert.deepEqual((await read()).entries, {});
		await write('{"columns":["todo","done"]}');
		assert.deepEqual((await read()).entries, { [settingsKey]: '{"columns":["todo","done"]}' });
	});

	await t.step("a board socket stays open while the hub hibernates, and a later write reaches it", "sleep", async () => {
		const board = await t.webSocket("/api/events", { headers: { authorization } });
		await t.waitForSleep();
		await t.json("/api/tasks", { method: "POST", headers, body: JSON.stringify({ projectId: "alpha", title: "After sleep" }) }, 201);
		await board.until((text) => text.includes('"type":"revision"'));
		await board.close();
	});

	await t.step("the hub sleeps, and the settings come back when it wakes", "sleep", async () => {
		await t.waitForSleep();
		const { entries } = await t.json<{ entries: Record<string, unknown> }>("/api/client-storage", { headers });
		assert.deepEqual(entries, { [settingsKey]: '{"columns":["todo","done"]}' });
	});

	await t.step("settings and tasks survive a restart, and a new socket gets revisions", "restart", async () => {
		await t.restart();
		const { entries } = await t.json<{ entries: Record<string, unknown> }>("/api/client-storage", { headers });
		assert.deepEqual(entries, { [settingsKey]: '{"columns":["todo","done"]}' });
		const { tasks } = await t.json<{ tasks: { title: string }[] }>("/api/tasks?projectId=alpha", { headers });
		assert.ok(tasks.some((task) => task.title === "Ship it"));
		const board = await t.webSocket("/api/events", { headers: { authorization } });
		await t.json("/api/tasks", { method: "POST", headers, body: JSON.stringify({ projectId: "alpha", title: "After restart" }) }, 201);
		await board.until((text) => text.includes('"type":"revision"'));
		await board.close();
	});
};

export default scenario;
