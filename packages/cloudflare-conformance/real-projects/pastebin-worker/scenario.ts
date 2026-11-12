import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

interface Created {
	url: string;
	manageUrl: string;
}

const channelSocket = (id: string) => `/live/ws/${id}`;
const isPeers = (count: number) => (text: string) => text === JSON.stringify({ t: "peers", n: count });

const scenario: Scenario = async (t) => {
	const paste = (content: string | Blob): Promise<Created> => {
		const form = new FormData();
		form.set("c", content);
		return t.json<Created>("/", { method: "POST", body: form });
	};
	const pathOf = (url: string) => new URL(url).pathname;

	let small: Created | undefined;
	let large: Created | undefined;
	const largeBody = "0123456789abcdef".repeat(2048);

	await t.step("peers stay connected across the channel's hibernation, and a frame wakes it", "sleep", async () => {
		// First step of the run: KV and R2 are actors too, and waitForSleep returns on any actor's sleep.
		const id = "22222222222222222222222222222222";
		const alice = await t.webSocket(channelSocket(id));
		await alice.until(isPeers(1));
		const bob = await t.webSocket(channelSocket(id));
		await bob.until(isPeers(2));
		await alice.until(isPeers(2));
		await t.waitForSleep();
		const frame = new Uint8Array([9, 8, 7]);
		alice.send(frame);
		assert.deepEqual(new Uint8Array(await bob.nextBytes()), frame);
		await alice.close();
		await bob.close();
	});

	await t.step("serves the rendered index page", "http", async () => {
		assert.match(await t.text("/"), /<title>Pastebin Worker<\/title>/);
	});

	await t.step("a small paste is kept in KV, and can be edited and deleted", "binding", async () => {
		small = await paste("first text");
		const path = pathOf(small.url);
		assert.equal(await t.text(path), "first text");
		assert.equal((await t.json<{ location: string }>(`/m${path}`)).location, "KV");
		const form = new FormData();
		form.set("c", "second text");
		await t.json(pathOf(small.manageUrl), { method: "PUT", body: form });
		assert.equal(await t.text(path), "second text");
		const doomed = await paste("doomed");
		await t.text(pathOf(doomed.manageUrl), { method: "DELETE" });
		await t.text(pathOf(doomed.url), undefined, 404);
	});

	await t.step("a paste over the threshold is kept in R2", "binding", async () => {
		large = await paste(new Blob([largeBody]));
		const path = pathOf(large.url);
		assert.equal((await t.json<{ location: string }>(`/m${path}`)).location, "R2");
		assert.equal(await t.text(path), largeBody);
	});

	const channel = "0123456789abcdef0123456789abcdef";
	await t.step("the channel relays encrypted frames to the other peer and counts peers", "websocket", async () => {
		const alice = await t.webSocket(channelSocket(channel));
		await alice.until(isPeers(1));
		const bob = await t.webSocket(channelSocket(channel));
		await bob.until(isPeers(2));
		await alice.until(isPeers(2));
		const frame = new Uint8Array([1, 2, 3, 250, 251, 252]);
		alice.send(frame);
		assert.deepEqual(new Uint8Array(await bob.nextBytes()), frame);
		await bob.close();
		await alice.until(isPeers(1));
		await alice.close();
	});

	await t.step("the channel answers ping and refuses a text frame", "websocket", async () => {
		const alice = await t.webSocket(channelSocket("11111111111111111111111111111111"));
		await alice.until(isPeers(1));
		alice.send("ping");
		assert.equal(await alice.next(), "pong");
		alice.send("not a frame");
		assert.deepEqual(JSON.parse(await alice.next()), { t: "error", msg: "expected a binary frame, frame dropped" });
		await alice.close();
	});

	await t.step("pastes survive a restart, and a channel works after it", "restart", async () => {
		await t.restart();
		assert.ok(small !== undefined && large !== undefined);
		assert.equal(await t.text(pathOf(small.url)), "second text");
		assert.equal(await t.text(pathOf(large.url)), largeBody);
		const alice = await t.webSocket(channelSocket("33333333333333333333333333333333"));
		await alice.until(isPeers(1));
		await alice.close();
	});
};

export default scenario;
