import assert from "node:assert/strict";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

interface User {
	id: string;
	name: string;
	joined: boolean;
	raisedHand: boolean;
	speaking: boolean;
	tracks: { audioUnavailable: boolean; audioEnabled?: boolean };
}
interface RoomState {
	type: "roomState";
	state: { users: User[] };
}

// The messages of app/hooks/useRoom.ts over the partysocket URL.
const scenario: Scenario = async (t) => {
	const signIn = async (username: string): Promise<string> => {
		const response = await t.fetch("/set-username", {
			method: "POST",
			body: new URLSearchParams({ username }),
			redirect: "manual",
		});
		const cookie = response.headers.get("set-cookie");
		assert.ok(cookie !== null, `no session cookie, status ${response.status}`);
		return cookie.split(";")[0]!;
	};
	const join = (room: string, id: string, cookie: string): Promise<TestSocket> =>
		t.webSocket(`/parties/rooms/${room}?_pk=${id}`, { headers: { Cookie: cookie } });
	const ofType = (type: string) => (text: string) => (JSON.parse(text) as { type: string }).type === type;
	const roomStateWith = async (socket: TestSocket, accept: (users: User[]) => boolean): Promise<User[]> => {
		const text = await socket.until(
			(message) => ofType("roomState")(message) && accept((JSON.parse(message) as RoomState).state.users),
		);
		return (JSON.parse(text) as RoomState).state.users;
	};
	const names = (users: User[]) => users.map((user) => user.name).sort();

	let aliceCookie = "";
	let bobCookie = "";

	await t.step("a display name gets a session, and the home page renders", "http", async () => {
		aliceCookie = await signIn("Alice");
		bobCookie = await signIn("Bob");
		assert.match(await t.text("/", { headers: { Cookie: aliceCookie } }), /<html/);
	});

	await t.step("a socket with no session is refused", "websocket", async () => {
		await assert.rejects(t.webSocket("/parties/rooms/closed?_pk=nobody"), /HTTP 401/);
	});

	await t.step("a reconnecting user gets their stored state back after the room sleeps", "sleep", async () => {
		// The first room of the run: waitForSleep returns on any actor's sleep.
		const first = await join("sticky", "carol-1", aliceCookie);
		const [self] = await roomStateWith(first, (users) => users.length === 1);
		assert.ok(self !== undefined);
		first.send(JSON.stringify({ type: "userUpdate", user: { ...self, joined: true, raisedHand: true } }));
		await roomStateWith(first, (users) => users[0]?.raisedHand === true);
		await first.close();
		await t.waitForSleep();
		const second = await join("sticky", "carol-1", aliceCookie);
		const users = await roomStateWith(second, (list) => list.length >= 1);
		assert.equal(users.find((user) => user.id === "carol-1")?.raisedHand, true);
		await second.close();
	});

	await t.step("two users see each other, and updates, direct messages, and mute reach them", "websocket", async () => {
		const alice = await join("standup", "alice-1", aliceCookie);
		await roomStateWith(alice, (users) => names(users).join() === "Alice");
		const bob = await join("standup", "bob-1", bobCookie);
		const both = await roomStateWith(bob, (users) => names(users).join() === "Alice,Bob");
		const self = both.find((user) => user.id === "alice-1");
		assert.ok(self !== undefined);
		alice.send(JSON.stringify({ type: "userUpdate", user: { ...self, joined: true, raisedHand: true } }));
		await roomStateWith(bob, (users) => users.find((user) => user.id === "alice-1")?.raisedHand === true);
		alice.send(JSON.stringify({ type: "directMessage", to: "bob-1", message: "psst" }));
		const direct = JSON.parse(await bob.until(ofType("directMessage"))) as { from: string; message: string };
		assert.deepEqual([direct.from, direct.message], ["Alice", "psst"]);
		alice.send(JSON.stringify({ type: "muteUser", id: "bob-1" }));
		await bob.until(ofType("muteMic"));
		bob.send(JSON.stringify({ type: "userLeft" }));
		const left = JSON.parse(await alice.until(ofType("userLeftNotification"))) as { id: string };
		assert.equal(left.id, "bob-1");
		await roomStateWith(alice, (users) => names(users).join() === "Alice");
		await alice.close();
		await bob.close();
	});

	await t.step("the room's alarm drops a user who stops sending heartbeats", "alarm", async () => {
		const alice = await join("watched", "alice-2", aliceCookie);
		await roomStateWith(alice, (users) => names(users).join() === "Alice");
		const bob = await join("watched", "bob-2", bobCookie);
		await bob.until(ofType("roomState"));
		// The client sends a heartbeat every 5 s. Only Alice goes on.
		const heartbeats = setInterval(() => alice.send(JSON.stringify({ type: "heartbeat" })), 5_000);
		try {
			const left = JSON.parse(await alice.until(ofType("userLeftNotification"), 45_000)) as { id: string };
			assert.equal(left.id, "bob-2");
			await roomStateWith(alice, (users) => names(users).join() === "Alice");
		} finally {
			clearInterval(heartbeats);
			await alice.close();
			await bob.close();
		}
	});

	await t.step("rooms sleep once their users are gone and their alarms have ended", "sleep", async () => {
		// Long enough for each room's last alarm and idle timeout. The fetch restarts the window.
		await t.delay(40_000);
		await t.text("/set-username");
		await t.waitForSleep(20_000);
	});

	await t.step("a stored session and its alarm survive a restart: the overdue alarm drops the silent user", "restart", async () => {
		const first = await join("durable", "dave-1", aliceCookie);
		await roomStateWith(first, (users) => users.length === 1);
		await first.close();
		await t.restart();
		const deadline = Date.now() + 45_000;
		const dropped = /eventName: 'userTimedOut',\s+connectionId: 'dave-1'/;
		while (!dropped.test(t.output())) {
			assert.ok(Date.now() < deadline, "the room's alarm did not drop dave-1 after the restart");
			await t.delay(250);
		}
		const erin = await join("durable", "erin-1", bobCookie);
		const users = await roomStateWith(erin, (list) => list.some((user) => user.id === "erin-1"));
		assert.deepEqual(users.map((user) => user.id), ["erin-1"]);
		await erin.close();
	});

	t.needsSecrets("a call goes through the Realtime SFU", "binding", ["CALLS_APP_ID", "CALLS_APP_SECRET"]);
};

export default scenario;
