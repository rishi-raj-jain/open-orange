import assert from "node:assert/strict";

import type { Scenario, ScenarioContext } from "../../src/real-projects/scenario.js";

async function until(t: ScenarioContext, path: string, done: (body: any) => boolean, timeoutMs = 20_000): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	let body: any;
	while (Date.now() < deadline) {
		body = await t.json(path);
		if (done(body)) return body;
		await t.delay(250);
	}
	throw new Error(`${path} did not reach the expected state: ${JSON.stringify(body)}`);
}

const scenario: Scenario = async (t) => {
	await t.step("storage: a value survives the object's sleep", "sleep", async () => {
		await t.json("/put?value=kept");
		await t.waitForSleep();
		assert.deepEqual(await t.json("/get"), { value: "kept" });
	});
	await t.step("alarm: fires on time", "alarm", async () => {
		await t.json("/alarm?room=a1&ms=500");
		await until(t, "/fired?room=a1", (body) => body.fired === 1);
	});
	await t.step("alarm: wakes a sleeping object with no request", "alarm", async () => {
		await t.json("/alarm?room=a2&ms=20000");
		await t.waitForSleep();
		const deadline = Date.now() + 30_000;
		while (!t.output().includes("lifecycle-alarm-fired") || (t.output().match(/lifecycle-alarm-fired/g) ?? []).length < 2) {
			if (Date.now() > deadline) throw new Error("The alarm did not fire while the object slept");
			await t.delay(250);
		}
	});
	await t.step("alarm: a future alarm survives a restart", "restart", async () => {
		await t.json("/alarm?room=a3&ms=15000");
		await t.restart();
		await t.delay(16_000);
		assert.deepEqual(await t.json("/fired?room=a3"), { fired: 1 });
	});
	await t.step("alarm: an alarm due while the process is down fires after a restart, with no request", "restart", async () => {
		await t.json("/alarm?room=a4&ms=500");
		await t.restart();
		const deadline = Date.now() + 30_000;
		while (!t.output().includes("lifecycle-alarm-fired")) {
			if (Date.now() > deadline) throw new Error("The overdue alarm did not fire");
			await t.delay(250);
		}
	});
	await t.step("hibernation: a socket stays open through the object's sleep, and a message wakes it", "sleep", async () => {
		const socket = await t.webSocket("/ws?room=h1");
		socket.send("before");
		assert.equal(await socket.next(), "echo:before");
		await t.waitForSleep();
		socket.send("after");
		assert.equal(await socket.next(), "echo:after");
		await socket.close();
	});
	await t.step("hibernation: an object that closes its own socket still sleeps", "sleep", async () => {
		const socket = await t.webSocket("/ws?room=h2");
		socket.send("bye");
		await t.waitForSleep();
		await socket.close();
	});

	await t.step("open socket: an idle socket stays open past the sleep timeout", "websocket", async () => {
		const socket = await t.webSocket("/ws?room=k1");
		await t.delay(15_000);
		socket.send("still there");
		assert.equal(await socket.next(), "echo:still there");
		await socket.close();
	});
	await t.step("open socket: an idle object drops its in-memory state while its socket stays open", "websocket", async () => {
		const socket = await t.webSocket("/ws?room=k2");
		socket.send("count");
		assert.equal(await socket.next(), "count:1");
		await t.delay(15_000);
		socket.send("count");
		// A new instance answers, so its counter starts again.
		assert.equal(await socket.next(), "count:1");
		await socket.close();
	});
	await t.step("open socket: the object sleeps after its last socket closes", "sleep", async () => {
		const socket = await t.webSocket("/ws?room=k3");
		socket.send("before");
		await socket.next();
		await socket.close();
		await t.waitForSleep();
	});
	await t.step("open socket: webSocketClose gets the client's close code", "websocket", async () => {
		const socket = await t.webSocket("/ws?room=k4");
		await socket.close();
		await until(t, "/closed?room=k4", (body) => body.code === 1000);
	});
	await t.step("open socket: a restart closes it with 1012, and a reconnect finds storage", "restart", async () => {
		await t.json("/put?room=k5&value=kept");
		const socket = await t.webSocket("/ws?room=k5");
		await t.restart();
		await assert.rejects(socket.next(), /1012/);
		const again = await t.webSocket("/ws?room=k5");
		again.send("back");
		assert.equal(await again.next(), "echo:back");
		assert.deepEqual(await t.json("/get?room=k5"), { value: "kept" });
		await again.close();
	});
	await t.step("open socket: a crash closes it with 1006, and a reconnect finds storage", "restart", async () => {
		await t.json("/put?room=k6&value=kept");
		const socket = await t.webSocket("/ws?room=k6");
		await t.crash();
		await assert.rejects(socket.next(), /1006/);
		const again = await t.webSocket("/ws?room=k6");
		again.send("back");
		assert.equal(await again.next(), "echo:back");
		assert.deepEqual(await t.json("/get?room=k6"), { value: "kept" });
		await again.close();
	});

	await t.step("KV-backed class: the storage API keeps a value", "do-state", async () => {
		await t.json("/legacy/put");
		assert.deepEqual(await t.json("/legacy/get"), { value: "kept" });
	});
	await t.step("KV-backed class: SQL is available", "do-state", async () => {
		assert.deepEqual((await t.json("/legacy/sql")).rows, [{ v: 1 }]);
	});

	const flow = (name: string, body: () => Promise<void>) => t.step(name, "binding", body);
	await flow("Workflows: create, step, status, complete", async () => {
		await t.json("/flow/start/one");
		await until(t, "/flow/status/one", (body) => body.status === "complete");
	});
	await flow("Workflows: sendEvent releases a waiting instance", async () => {
		await t.json("/flow/start/two?wait");
		await until(t, "/flow/status/two", (body) => body.status === "waiting" || body.status === "running");
		await t.json("/flow/event/two");
		await until(t, "/flow/status/two", (body) => body.status === "complete");
	});
	await flow("Workflows: terminate() ends a waiting instance", async () => {
		await t.json("/flow/start/three?wait");
		await until(t, "/flow/status/three", (body) => body.status === "waiting" || body.status === "running");
		await t.json("/flow/terminate/three");
		await until(t, "/flow/status/three", (body) => body.status === "terminated");
	});
	await flow("Workflows: pause() and resume()", async () => {
		await t.json("/flow/start/four?wait");
		await until(t, "/flow/status/four", (body) => body.status === "waiting" || body.status === "running");
		await t.json("/flow/pause/four");
		await until(t, "/flow/status/four", (body) => body.status === "paused");
		await t.json("/flow/resume/four");
		await until(t, "/flow/status/four", (body) => body.status === "waiting" || body.status === "running");
	});
	await flow("Workflows: restart() runs a finished instance again", async () => {
		await t.json("/flow/start/five");
		await until(t, "/flow/status/five", (body) => body.status === "complete");
		await t.json("/flow/restart/five");
		await until(t, "/flow/status/five", (body) => body.status === "complete");
	});
};

export default scenario;
