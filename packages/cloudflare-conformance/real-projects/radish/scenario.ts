import assert from "node:assert/strict";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

const headers = { "x-radish-auth": "local-only-token" };

// The bytes redis-cli sends. The project's TCP shim forwards them to the WebSocket unchanged.
function resp(...words: string[]): Uint8Array {
	const parts = words.map((word) => `$${Buffer.byteLength(word)}\r\n${word}\r\n`);
	return new TextEncoder().encode(`*${words.length}\r\n${parts.join("")}`);
}

const scenario: Scenario = async (t) => {
	const connect = (db = "default"): Promise<TestSocket> => t.webSocket(`/connect?db=${db}`, { headers });
	const call = async (socket: TestSocket, ...words: string[]): Promise<string> => {
		socket.send(resp(...words));
		return await socket.next();
	};

	await t.step("the health route answers, and a wrong token cannot connect", "http", async () => {
		assert.equal((await t.json<{ service: string }>("/health")).service, "radish");
		await assert.rejects(t.webSocket("/connect", { headers: { "x-radish-auth": "wrong" } }), /HTTP 401/);
	});

	await t.step("Redis commands of each type keep their data across connections", "do-state", async () => {
		const writer = await connect();
		assert.equal(await call(writer, "PING"), "+PONG\r\n");
		assert.equal(await call(writer, "SET", "greeting", "hello"), "+OK\r\n");
		assert.equal(await call(writer, "INCR", "visits"), ":1\r\n");
		assert.equal(await call(writer, "INCR", "visits"), ":2\r\n");
		assert.equal(await call(writer, "RPUSH", "queue", "a", "b"), ":2\r\n");
		assert.equal(await call(writer, "HSET", "user", "name", "ann"), ":1\r\n");
		assert.equal(await call(writer, "ZADD", "board", "2", "two", "1", "one"), ":2\r\n");
		await writer.close();
		const reader = await connect();
		assert.equal(await call(reader, "GET", "greeting"), "$5\r\nhello\r\n");
		assert.equal(await call(reader, "LRANGE", "queue", "0", "-1"), "*2\r\n$1\r\na\r\n$1\r\nb\r\n");
		assert.equal(await call(reader, "HGET", "user", "name"), "$3\r\nann\r\n");
		assert.equal(await call(reader, "ZRANGE", "board", "0", "-1"), "*2\r\n$3\r\none\r\n$3\r\ntwo\r\n");
		await reader.close();
	});

	await t.step("MULTI runs queued commands together, and another db name is another instance", "do-state", async () => {
		const client = await connect();
		assert.equal(await call(client, "MULTI"), "+OK\r\n");
		assert.equal(await call(client, "SET", "a", "1"), "+QUEUED\r\n");
		assert.equal(await call(client, "INCR", "a"), "+QUEUED\r\n");
		assert.equal(await call(client, "EXEC"), "*2\r\n+OK\r\n:2\r\n");
		await client.close();
		const other = await connect("sessions");
		assert.equal(await call(other, "GET", "greeting"), "$-1\r\n");
		await other.close();
	});

	await t.step("a subscriber receives what another connection publishes", "websocket", async () => {
		const subscriber = await connect();
		assert.match(await call(subscriber, "SUBSCRIBE", "news"), /subscribe/);
		const publisher = await connect();
		assert.equal(await call(publisher, "PUBLISH", "news", "hi"), ":1\r\n");
		assert.match(await subscriber.next(), /message[\s\S]*news[\s\S]*hi/);
		await subscriber.close();
		await publisher.close();
	});

	await t.step("a connection keeps its name while the object hibernates", "sleep", async () => {
		const client = await connect();
		assert.equal(await call(client, "CLIENT", "SETNAME", "worker-1"), "+OK\r\n");
		await t.waitForSleep(60_000);
		assert.equal(await call(client, "CLIENT", "GETNAME"), "$8\r\nworker-1\r\n");
		await client.close();
	});

	await t.step("the expiry alarm wakes the sleeping object and removes the key", "alarm", async () => {
		const client = await connect("expiry");
		assert.equal(await call(client, "SET", "soon", "x", "PX", "20000"), "+OK\r\n");
		assert.equal(await call(client, "SET", "keep", "y"), "+OK\r\n");
		await client.close();
		await t.waitForSleep(60_000);
		const started = () => [...t.output().matchAll(/old=Loading new=Started/g)].length;
		const before = started();
		const deadline = Date.now() + 30_000;
		while (started() === before) {
			assert.ok(Date.now() < deadline, "No actor started within 30 s of the key's expiry");
			await t.delay(100);
		}
		const reader = await connect("expiry");
		assert.equal(await call(reader, "EXISTS", "soon"), ":0\r\n");
		assert.equal(await call(reader, "GET", "keep"), "$1\r\ny\r\n");
		await reader.close();
	});

	await t.step("the data survives the object's sleep", "sleep", async () => {
		await t.waitForSleep(60_000);
		const client = await connect();
		assert.equal(await call(client, "GET", "visits"), "$1\r\n2\r\n");
		await client.close();
	});

	await t.step("the data survives an orange dev and engine restart", "restart", async () => {
		await t.restart();
		const client = await connect();
		assert.equal(await call(client, "GET", "greeting"), "$5\r\nhello\r\n");
		assert.equal(await call(client, "INCR", "visits"), ":3\r\n");
		await client.close();
	});
};

export default scenario;
