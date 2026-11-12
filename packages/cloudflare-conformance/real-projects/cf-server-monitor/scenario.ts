import assert from "node:assert/strict";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

const secret = "local-only-api-secret-for-the-monitor-01";

interface BatchUpdate {
	type: string;
	updates: { serverId: string; samples: { data?: { cpu?: number }; payload?: { cpu?: number } }[] }[];
}

const scenario: Scenario = async (t) => {
	const admin = <T>(body: object, token?: string, status = 200) =>
		t.json<T>(
			"/admin/api",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
				},
				body: JSON.stringify(body),
			},
			status,
		);
	const login = async () => (await admin<{ token: string }>({ action: "login", username: "admin", password: secret })).token;
	// What the probe sends over HTTP.
	const report = (id: string, cpu: number) =>
		t.text("/update", {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": "cfsm", "x-agent-version": "2.8.6" },
			body: JSON.stringify({ id, secret, metrics: { cpu, ram_total: 100, ram_used: 40 } }),
		});
	const sees = (socket: TestSocket, id: string, cpu: number) =>
		socket.until((text) => {
			const message = JSON.parse(text) as BatchUpdate;
			return (
				message.type === "batchUpdate" &&
				message.updates.some(
					(update) => update.serverId === id && update.samples.some((sample) => (sample.data ?? sample.payload)?.cpu === cpu),
				)
			);
		});
	const health = () => t.json<{ ok: boolean; subscribers: number }>("/__do/health");

	let id = "";

	await t.step("the dashboard and its config are served", "http", async () => {
		assert.match(await t.text("/"), /<html/i);
		await t.json("/api/config");
	});

	await t.step("the admin logs in and adds a server, which is stored in D1", "binding", async () => {
		await admin({ action: "login", username: "admin", password: "wrong" }, undefined, 401);
		const token = await login();
		const added = await admin<{ success: boolean; id: string }>({ action: "add", name: "edge-1", server_group: "Default" }, token);
		assert.equal(added.success, true);
		id = added.id;
		assert.match(JSON.stringify(await admin({ action: "list" }, token)), /edge-1/);
	});

	await t.step("the broadcaster counts its subscribers across requests", "do-state", async () => {
		assert.equal((await health()).subscribers, 0);
		const browser = await t.webSocket(`/api/ws?subscribe=${id}`);
		assert.equal(JSON.parse(await browser.next()).type, "hello");
		assert.equal((await health()).subscribers, 1);
		browser.send(JSON.stringify({ type: "subscribe", scope: id, ids: [id] }));
		assert.equal(JSON.parse(await browser.until((text) => text.includes('"subscribed"') && !text.includes('"hello"'))).count, 1);
		await browser.close();
	});

	await t.step("a probe's HTTP report reaches a subscribed browser", "websocket", async () => {
		const browser = await t.webSocket(`/api/ws?subscribe=${id}`);
		await browser.until((text) => text.includes('"hello"'));
		await report(id, 11);
		await sees(browser, id, 11);
		await browser.close();
	});

	await t.step("a probe reports over WebSocket, gets an ack, and reaches the browser", "websocket", async () => {
		const browser = await t.webSocket(`/api/ws?subscribe=${id}`);
		await browser.until((text) => text.includes('"hello"'));
		const probe = await t.webSocket("/update", { headers: { "user-agent": "cfsm", "x-agent-version": "2.8.6" } });
		assert.equal(JSON.parse(await probe.next()).protocol, "update");
		probe.send(JSON.stringify({ id, secret, metrics: { cpu: 22, ram_total: 100, ram_used: 41 } }));
		await probe.until((text) => JSON.parse(text).type === "ack");
		await sees(browser, id, 22);
		await probe.close();
		await browser.close();
	});

	await t.step("a browser stays subscribed while the broadcaster hibernates", "sleep", async () => {
		const browser = await t.webSocket(`/api/ws?subscribe=${id}`);
		await browser.until((text) => text.includes('"hello"'));
		await t.waitForSleep();
		await report(id, 33);
		await sees(browser, id, 33);
		await browser.close();
	});

	await t.step("the server and the login survive a restart, and reports flow again", "restart", async () => {
		await t.restart();
		const token = await login();
		assert.match(JSON.stringify(await admin({ action: "list" }, token)), /edge-1/);
		const browser = await t.webSocket(`/api/ws?subscribe=${id}`);
		await browser.until((text) => text.includes('"hello"'));
		await report(id, 44);
		await sees(browser, id, 44);
		await browser.close();
	});
};

export default scenario;
