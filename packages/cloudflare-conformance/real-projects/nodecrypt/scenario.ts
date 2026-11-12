import assert from "node:assert/strict";
import {
	createCipheriv,
	createDecipheriv,
	createECDH,
	createHash,
	createPublicKey,
	randomBytes,
	verify,
} from "node:crypto";

import type { Scenario, ScenarioContext, TestSocket } from "../../src/real-projects/scenario.js";

interface ServerMessage {
	a: string;
	p: unknown;
	c?: string;
}

interface Member {
	socket: TestSocket;
	serverKey: string;
	send(message: object): void;
	/** The next decrypted message that `match` accepts. */
	until(match: (message: ServerMessage) => boolean): Promise<ServerMessage>;
}

// The same framing as client/js/NodeCrypt.js: AES-256-CBC with zero padding, `iv|ciphertext` in base64.
function encrypt(message: object, key: Buffer): string {
	const plain = Buffer.from(JSON.stringify(message), "utf8");
	const padded = plain.length % 16 === 0 ? plain : Buffer.concat([plain, Buffer.alloc(16 - (plain.length % 16))]);
	const iv = randomBytes(16);
	const cipher = createCipheriv("aes-256-cbc", key, iv);
	cipher.setAutoPadding(false);
	return `${iv.toString("base64")}|${Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64")}`;
}

function decrypt(text: string, key: Buffer): ServerMessage {
	const [iv, body] = text.split("|");
	const decipher = createDecipheriv("aes-256-cbc", key, Buffer.from(iv!, "base64"));
	decipher.setAutoPadding(false);
	const plain = Buffer.concat([decipher.update(Buffer.from(body!, "base64")), decipher.final()]).toString("utf8");
	return JSON.parse(plain.replace(/\0+$/, "")) as ServerMessage;
}

// What the browser client does: read the server's RSA key, send an ECDH key, verify the signed reply, join the channel.
async function join(t: ScenarioContext, room: string): Promise<Member> {
	const socket = await t.webSocket("/");
	const { type, key: serverKey } = JSON.parse(await socket.next()) as { type: string; key: string };
	assert.equal(type, "server-key");

	const ecdh = createECDH("secp384r1");
	socket.send(ecdh.generateKeys("hex"));

	const [serverEcdh, signature] = (await socket.next()).split("|");
	const rsaPublic = createPublicKey({ key: Buffer.from(serverKey, "base64"), format: "der", type: "spki" });
	const signed = verify("sha256", Buffer.from(serverEcdh!, "hex"), rsaPublic, Buffer.from(signature!, "base64"));
	assert.equal(signed, true, "the server's ECDH key is not signed by its RSA key");
	const shared = ecdh.computeSecret(Buffer.from(serverEcdh!, "hex")).subarray(8, 40);

	const send = (message: object) => socket.send(encrypt(message, shared));
	send({ a: "j", p: createHash("sha256").update(room).digest("hex") });
	return {
		socket,
		serverKey,
		send,
		async until(match) {
			const text = await socket.until((frame) => frame !== "pong" && match(decrypt(frame, shared)));
			return decrypt(text, shared);
		},
	};
}

const memberList = (message: ServerMessage) => message.a === "l";
const listOf = (ids: string[]) => (message: ServerMessage) =>
	message.a === "l" && JSON.stringify(message.p) === JSON.stringify(ids);

const scenario: Scenario = async (t) => {
	let firstServerKey = "";

	await t.step("serves the built client, its SPA fallback, and the API route", "http", async () => {
		assert.match(await t.text("/"), /<title>NodeCrypt<\/title>/);
		assert.match(await t.text("/some/room"), /<title>NodeCrypt<\/title>/);
		assert.deepEqual(await t.json("/api/anything"), { ok: true });
	});

	await t.step("two clients secure a session, join a room, and pass messages through the object", "websocket", async () => {
		const alice = await join(t, "room-a");
		await alice.until(listOf([]));
		firstServerKey = alice.serverKey;

		const bob = await join(t, "room-a");
		const bobList = await bob.until(memberList);
		const aliceId = (bobList.p as string[])[0]!;
		const aliceList = await alice.until((message) => message.a === "l" && (message.p as string[]).length === 1);
		const bobId = (aliceList.p as string[])[0]!;

		// The peer keys the real client sends here are opaque to the object, so these are too.
		alice.send({ a: "w", p: { [bobId]: "alice-to-bob" } });
		const fromAlice = await bob.until((message) => message.a === "c");
		assert.deepEqual(fromAlice, { a: "c", p: "alice-to-bob", c: aliceId });

		bob.send({ a: "c", p: "bob-to-alice", c: aliceId });
		const fromBob = await alice.until((message) => message.a === "c");
		assert.deepEqual(fromBob, { a: "c", p: "bob-to-alice", c: bobId });

		await bob.socket.close();
		await alice.until(listOf([]));
		await alice.socket.close();
	});

	await t.step("a client in another room does not see this room's members", "websocket", async () => {
		const alice = await join(t, "room-b");
		await alice.until(listOf([]));
		const carol = await join(t, "room-c");
		await carol.until(listOf([]));
		const bob = await join(t, "room-b");
		const list = await bob.until(memberList);
		assert.equal((list.p as string[]).length, 1);
		await alice.until((message) => message.a === "l" && (message.p as string[]).length === 1);
		await Promise.all([alice.socket.close(), bob.socket.close(), carol.socket.close()]);
	});

	await t.step("an open socket keeps the room in memory while the client stays idle", "websocket", async () => {
		const alice = await join(t, "room-idle");
		await alice.until(listOf([]));
		await t.delay(15_000);
		alice.socket.send("ping");
		assert.equal(await alice.socket.until((frame) => frame === "pong"), "pong");
		const bob = await join(t, "room-idle");
		const list = await bob.until(memberList);
		assert.equal((list.p as string[]).length, 1, "the room lost its member while the socket stayed open");
		await bob.socket.close();
		await alice.socket.close();
	});

	await t.step("the server's RSA key comes back from storage after the object sleeps", "sleep", async () => {
		await t.waitForSleep();
		const alice = await join(t, "room-sleep");
		await alice.until(listOf([]));
		assert.equal(alice.serverKey, firstServerKey);
		await alice.socket.close();
	});

	await t.step("the server's RSA key survives an orange dev and engine restart", "restart", async () => {
		await t.restart();
		const alice = await join(t, "room-restart");
		await alice.until(listOf([]));
		assert.equal(alice.serverKey, firstServerKey);
		await alice.socket.close();
	});
};

export default scenario;
