import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import type { Scenario } from "../../src/real-projects/scenario.js";

const admin = { Authorization: "Bearer ABC123", "Content-Type": "application/json" };

const scenario: Scenario = async (t) => {
	const query = async <T = any>(sql: string, params: unknown[] = []): Promise<T> => {
		const body = await t.json<{ result: T }>("/query", {
			method: "POST",
			headers: admin,
			body: JSON.stringify({ sql, params }),
		});
		return body.result;
	};
	const artists = () => query("SELECT * FROM artist ORDER BY artistid");
	const alice = { artistid: 123, artistname: "Alice" };
	const bob = { artistid: 456, artistname: "Bob" };
	const charlie = { artistid: 789, artistname: "Charlie" };

	await t.step("a request without a token gets 401", "http", async () => {
		const response = await t.fetch("/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sql: "SELECT 1" }),
		});
		assert.equal(response.status, 401);
	});

	await t.step("a client creates a table, inserts rows, and reads them back", "do-state", async () => {
		await query("CREATE TABLE IF NOT EXISTS artist(artistid INTEGER PRIMARY KEY, artistname TEXT);");
		await query("INSERT INTO artist (artistid, artistname) VALUES (123, 'Alice'), (456, 'Bob');");
		assert.deepEqual(await artists(), [alice, bob]);
		const raw = await t.json<{ result: { columns: string[]; rows: unknown[][] } }>("/query/raw", {
			method: "POST",
			headers: admin,
			body: JSON.stringify({ sql: "SELECT * FROM artist ORDER BY artistid;", params: [] }),
		});
		assert.deepEqual(raw.result.columns, ["artistid", "artistname"]);
		assert.deepEqual(raw.result.rows, [[123, "Alice"], [456, "Bob"]]);
	});

	await t.step("the README's $1 query and transaction return their rows", "do-state", async () => {
		assert.deepEqual(await query("SELECT * FROM artist WHERE artistid=$1;", [123]), [alice]);
		const { result } = await t.json<{ result: unknown[] }>("/query", {
			method: "POST",
			headers: admin,
			body: JSON.stringify({
				transaction: [
					{ sql: "SELECT * FROM artist WHERE artistid=$1;", params: [456] },
					{ sql: "SELECT count(*) AS total FROM artist;", params: [] },
				],
			}),
		});
		assert.deepEqual(result, [[bob], [{ total: 2 }]]);
	});

	await t.step("the REST API writes a row, and the JSON export sees it", "do-state", async () => {
		const created = await t.fetch("/rest/main/artist", {
			method: "POST",
			headers: admin,
			body: JSON.stringify(charlie),
		});
		assert.equal(created.status, 201, await created.clone().text());
		const listed = await t.json<{ result: unknown[] }>("/rest/main/artist?sort_by=artistid", { headers: admin });
		assert.deepEqual(listed.result, [alice, bob, charlie]);
		const exported = await t.text("/export/json/artist", { headers: admin });
		assert.deepEqual(JSON.parse(exported), [alice, bob, charlie]);
	});

	await t.step("a WebSocket client queries the same database", "websocket", async () => {
		const socket = await t.webSocket("/socket?token=ABC123");
		socket.send(JSON.stringify({ sql: "SELECT artistname FROM artist WHERE artistid = 789", params: [], action: "query" }));
		assert.deepEqual(JSON.parse(await socket.next()), [{ artistname: "Charlie" }]);
		await socket.close();
	});

	await t.step("a cron task's alarm calls the task's callback host", "alarm", async () => {
		const calls: { url: string | undefined; auth: string | undefined; tasks: { name: string }[] }[] = [];
		let notify = () => {};
		const called = new Promise<void>((resolve) => {
			notify = resolve;
		});
		const callback = createServer((request: IncomingMessage, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				calls.push({ url: request.url, auth: request.headers.authorization, tasks: JSON.parse(body) });
				response.end("{}");
				notify();
			});
		});
		await new Promise<void>((resolve) => callback.listen(0, "127.0.0.1", resolve));
		try {
			const { port } = callback.address() as AddressInfo;
			// The same row CronPlugin.addEvent writes. A later request's middleware arms the alarm from it.
			await query(
				"INSERT OR REPLACE INTO tmp_cron_tasks (name, cron_tab, payload, callback_host) VALUES (?, ?, ?, ?)",
				["every-minute", "* * * * *", "{}", `http://127.0.0.1:${port}`],
			);
			await query("SELECT 1");
			// A cron minute is the shortest the project can ask for, plus the time to deliver it.
			await Promise.race([
				called,
				t.delay(75_000).then(() => {
					throw new Error("The cron callback was not called within 75 s");
				}),
			]);
			assert.equal(calls[0]!.url, "/cron/callback");
			assert.equal(calls[0]!.auth, "Bearer DEF456");
			assert.equal(calls[0]!.tasks[0]!.name, "every-minute");
		} finally {
			await query("DELETE FROM tmp_cron_tasks WHERE name = ?", ["every-minute"]).catch(() => undefined);
			callback.closeAllConnections();
			callback.close();
		}
	});

	await t.step("the table survives the object's sleep", "sleep", async () => {
		await t.waitForSleep();
		assert.deepEqual(await artists(), [alice, bob, charlie]);
	});

	await t.step("the table survives an orange dev and engine restart", "restart", async () => {
		await t.restart();
		assert.deepEqual(await artists(), [alice, bob, charlie]);
		await query("UPDATE artist SET artistname = 'Bobby' WHERE artistid = 456");
		assert.deepEqual(await query("SELECT artistname FROM artist WHERE artistid = 456"), [{ artistname: "Bobby" }]);
	});
};

export default scenario;
