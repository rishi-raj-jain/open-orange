import assert from "node:assert/strict";

import type { Scenario, ScenarioContext, TestSocket } from "../../src/real-projects/scenario.js";

// The SDK's AgentClient connects to /agents/<kebab-case class>/<name>, and calls @callable methods with this message.
let nextId = 0;
async function call<T = unknown>(socket: TestSocket, method: string, ...args: unknown[]): Promise<T> {
	const id = `call-${++nextId}`;
	socket.send(JSON.stringify({ type: "rpc", id, method, args }));
	const text = await socket.until((message) => message.includes(`"id":"${id}"`) && /"done":true|"success":false/.test(message));
	const reply = JSON.parse(text) as { success: boolean; result?: T; error?: string };
	if (!reply.success) throw new Error(`${method} failed: ${reply.error}`);
	return reply.result as T;
}

interface StateAgentState {
	counter: number;
	items: string[];
	lastUpdated: string | null;
}

const isState = (message: string) => message.includes('"type":"cf_agent_state"');

async function connect(t: ScenarioContext, path: string): Promise<{ socket: TestSocket; state: StateAgentState }> {
	const socket = await t.webSocket(path);
	const { state } = JSON.parse(await socket.until(isState)) as { state: StateAgentState };
	return { socket, state };
}

const scenario: Scenario = async (t) => {
	await t.step("two clients share an agent's state, through both callable methods and client updates", "websocket", async () => {
		const a = await connect(t, "/agents/state-agent/demo?_pk=a");
		const b = await connect(t, "/agents/state-agent/demo?_pk=b");
		assert.deepEqual(a.state, { counter: 0, items: [], lastUpdated: null });
		const returned = await call<StateAgentState>(a.socket, "increment");
		assert.equal(returned.counter, 1);
		const seen = JSON.parse(await b.socket.until(isState)) as { state: StateAgentState };
		assert.equal(seen.state.counter, 1);
		await call(a.socket, "addItem", "apple");
		await b.socket.until((message) => isState(message) && message.includes('"apple"'));
		b.socket.send(JSON.stringify({ type: "cf_agent_state", state: { counter: 100, items: ["apple"], lastUpdated: null } }));
		await a.socket.until((message) => isState(message) && message.includes('"counter":100'));
		await a.socket.close();
		await b.socket.close();
		const other = await connect(t, "/agents/state-agent/other?_pk=c");
		assert.equal(other.state.counter, 0);
		await other.socket.close();
	});

	await t.step("an agent's SQL records are read back through another connection", "do-state", async () => {
		const first = await t.webSocket("/agents/sql-agent/demo?_pk=a");
		await call(first, "insertRecord", "greeting", "hello");
		await first.close();
		const second = await t.webSocket("/agents/sql-agent/demo?_pk=b");
		const records = await call<{ key: string; value: string }[]>(second, "getRecords");
		assert.deepEqual(records.map(({ key, value }) => [key, value]), [["greeting", "hello"]]);
		const rows = await call<{ n: number }[]>(second, "executeQuery", "SELECT COUNT(*) AS n FROM playground_data");
		assert.equal(rows[0]!.n, 1);
		await assert.rejects(call(second, "executeQuery", "DELETE FROM playground_data"), /Only SELECT queries are allowed/);
		await second.close();
	});

	await t.step("a one-time task and a recurring task fire on schedule, and a cancelled task stops", "alarm", async () => {
		const socket = await t.webSocket("/agents/schedule-agent/demo?_pk=a");
		const oneTime = await call<string>(socket, "scheduleTask", 1, "soon");
		assert.equal(typeof oneTime, "string");
		const fired = JSON.parse(await socket.until((message) => message.includes('"type":"schedule_executed"'), 15_000));
		assert.deepEqual(fired.payload, { message: "soon" });
		const recurring = await call<string>(socket, "scheduleRecurring", 1, "tick");
		await socket.until((message) => message.includes('"type":"recurring_executed"'), 15_000);
		await socket.until((message) => message.includes('"type":"recurring_executed"'), 15_000);
		assert.equal(await call<boolean>(socket, "cancelTask", recurring), true);
		const left = await call<{ id: string }[]>(socket, "getScheduledTasks");
		assert.ok(!left.some((task) => task.id === recurring));
		await socket.close();
	});

	await t.step("a supervisor agent creates child agents and drives them over RPC", "do-state", async () => {
		const socket = await t.webSocket("/agents/supervisor-agent/demo?_pk=a");
		await call(socket, "createChild", "one");
		await call(socket, "createChild", "two");
		await call(socket, "incrementChild", "one");
		await call(socket, "incrementAll");
		const stats = await call<{ totalChildren: number; totalCounter: number }>(socket, "getStats");
		assert.equal(stats.totalChildren, 2);
		assert.equal(stats.totalCounter, 3);
		await socket.close();
	});

	await t.step("a client socket stays open while the agent hibernates, and a call wakes it", "sleep", async () => {
		await t.waitForSleep();
		const client = await connect(t, "/agents/state-agent/demo?_pk=d");
		await t.waitForSleep();
		const after = await call<StateAgentState>(client.socket, "increment");
		assert.equal(after.counter, 101);
		await client.socket.close();
	});

	await t.step("an agent sleeps, and its state, SQL, and children come back when it wakes", "sleep", async () => {
		await t.waitForSleep();
		const client = await connect(t, "/agents/state-agent/demo?_pk=e");
		assert.ok(client.state.counter >= 100, `counter is ${client.state.counter}`);
		assert.deepEqual(client.state.items, ["apple"]);
		await client.socket.close();
		const sql = await t.webSocket("/agents/sql-agent/demo?_pk=e");
		assert.equal((await call<unknown[]>(sql, "getRecords")).length, 1);
		await sql.close();
		const supervisor = await t.webSocket("/agents/supervisor-agent/demo?_pk=e");
		assert.equal((await call<{ totalCounter: number }>(supervisor, "getStats")).totalCounter, 3);
		await supervisor.close();
	});

	await t.step("state, SQL, and children survive a restart, and new schedules still fire", "restart", async () => {
		await t.restart();
		const client = await connect(t, "/agents/state-agent/demo?_pk=f");
		assert.ok(client.state.counter >= 100, `counter is ${client.state.counter}`);
		await client.socket.close();
		const sql = await t.webSocket("/agents/sql-agent/demo?_pk=f");
		assert.equal((await call<unknown[]>(sql, "getRecords")).length, 1);
		await sql.close();
		const supervisor = await t.webSocket("/agents/supervisor-agent/demo?_pk=f");
		assert.equal((await call<{ totalCounter: number }>(supervisor, "getStats")).totalCounter, 3);
		await supervisor.close();
		const schedule = await t.webSocket("/agents/schedule-agent/demo?_pk=f");
		await call(schedule, "scheduleTask", 1, "after restart");
		await schedule.until((message) => message.includes('"after restart"'), 15_000);
		await schedule.close();
	});

	t.needsSecrets("the chat agent streams an answer from Workers AI", "binding", ["Workers AI (remote AI binding)"]);
};

export default scenario;
