import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

const username = "owner-1";
const password = "supersecret99";
const period = 30;

function base32(input: string): Buffer {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = "";
	for (const character of input) bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
	return Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));
}

function totp(secret: string, step: number): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const digest = createHmac("sha1", base32(secret)).update(counter).digest();
	const offset = digest[digest.length - 1]! & 15;
	return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const scenario: Scenario = async (t) => {
	// The same client as the project's scripts/e2e.mjs: a header, JSON, and a session cookie.
	const client = () => {
		let cookie = "";
		return {
			get cookie() {
				return cookie;
			},
			async request<T = any>(method: string, path: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<T> {
				const response = await t.fetch(path, {
					method,
					headers: {
						"X-Inkstone-Client": "1",
						...(body === undefined ? {} : { "Content-Type": "application/json" }),
						...(cookie === "" ? {} : { Cookie: cookie }),
						...headers,
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
				for (const value of response.headers.getSetCookie()) {
					const pair = value.split(";")[0]!;
					if (pair.startsWith("inkstone_session=")) cookie = pair;
				}
				const text = await response.text();
				assert.equal(response.status, status, `${method} ${path}: ${text.slice(0, 400)}`);
				return (text === "" ? null : JSON.parse(text)) as T;
			},
		};
	};
	const owner = client();
	const socketFor = (session: { cookie: string }) => t.webSocket("/api/sync/ws", { headers: { Cookie: session.cookie } });
	const changed = async (socket: TestSocket, origin: string) =>
		JSON.parse(
			await socket.until((text) => {
				const message = JSON.parse(text) as { type: string; origin: string | null };
				return message.type === "changed" && message.origin === origin;
			}),
		) as { cursor: number };

	let totpSecret = "";
	let lastStep = 0;
	// A TOTP code works once, so each sign-in takes a later step than the last.
	const nextCode = async () => {
		const step = lastStep + 1;
		const now = () => Math.floor(Date.now() / 1000 / period);
		const startOfPreviousStep = (step - 1) * period * 1000;
		if (now() + 1 < step) await t.delay(startOfPreviousStep - Date.now() + 50);
		lastStep = Math.max(step, now() - 1);
		return totp(totpSecret, lastStep);
	};
	const signInWithCode = async () => {
		const device = client();
		const challenge = await device.request<{ challengeToken: string }>("POST", "/api/auth/login", { username, password });
		await device.request("POST", "/api/auth/totp/login", { challengeToken: challenge.challengeToken, code: await nextCode() });
		const session = await device.request<{ user: { username: string } | null }>("GET", "/api/auth/session");
		assert.equal(session.user?.username, username);
		return device;
	};

	await t.step("a fresh instance serves the app and reports that it has no owner", "http", async () => {
		assert.match(await t.text("/"), /<div id="root"/);
		const session = await owner.request<{ user: unknown; site: { initialized: boolean; realtimeEnabled: boolean } }>("GET", "/api/auth/session");
		assert.equal(session.user, null);
		assert.equal(session.site.initialized, false);
	});

	await t.step("the first account gets its starter notes, and a new note is stored", "binding", async () => {
		await owner.request("POST", "/api/auth/register", { username, password }, 201);
		const starters = await owner.request<{ notes: unknown[] }>("GET", "/api/notes?view=all");
		assert.equal(starters.notes.length, 2);
		const note = await owner.request<{ id: string }>("POST", "/api/notes", { title: "kept note", content: "# kept note" }, 201);
		assert.match((await owner.request<{ content: string }>("GET", `/api/notes/${note.id}`)).content, /kept note/);
	});

	await t.step("a change on one device notifies the other through SyncHub", "websocket", async () => {
		await assert.rejects(t.webSocket("/api/sync/ws"), /HTTP 401/);
		const socket = await socketFor(owner);
		socket.send(JSON.stringify({ type: "ping" }));
		await socket.until((text) => JSON.parse(text).type === "pong");
		const laptop = client();
		await laptop.request("POST", "/api/auth/login", { username, password });
		const before = await owner.request<{ cursor: number }>("GET", "/api/sync?since=0");
		await laptop.request("POST", "/api/notes", { content: "# from laptop" }, 201, { "X-Inkstone-Origin": "laptop" });
		const message = await changed(socket, "laptop");
		assert.ok(message.cursor > before.cursor);
		await socket.close();
	});

	await t.step("two-factor setup and sign-in go through CredentialVault", "do-state", async () => {
		const setup = await owner.request<{ secret: string; setupToken: string }>("POST", "/api/auth/totp/setup", { currentPassword: password });
		totpSecret = setup.secret;
		lastStep = Math.floor(Date.now() / 1000 / period);
		const confirmed = await owner.request<{ recoveryCodes: string[] }>("POST", "/api/auth/totp/setup/confirm", {
			setupToken: setup.setupToken,
			code: totp(totpSecret, lastStep),
		});
		assert.equal(confirmed.recoveryCodes.length, 10);
		await signInWithCode();
	});

	await t.step("a socket stays connected while SyncHub hibernates", "sleep", async () => {
		const socket = await socketFor(owner);
		await t.waitForSleep();
		await owner.request("POST", "/api/notes", { content: "# after hibernation" }, 201, { "X-Inkstone-Origin": "desktop" });
		await changed(socket, "desktop");
		await socket.close();
	});

	await t.step("CredentialVault still opens the stored secret after it sleeps", "sleep", async () => {
		await t.waitForSleep();
		await signInWithCode();
	});

	await t.step("the account, notes, and vault key survive a restart", "restart", async () => {
		await t.restart();
		const device = await signInWithCode();
		const all = await device.request<{ notes: { title: string }[] }>("GET", "/api/notes?view=all");
		assert.ok(all.notes.some((note) => /kept note/.test(note.title)), JSON.stringify(all.notes.map((note) => note.title)));
		const socket = await socketFor(device);
		await device.request("POST", "/api/notes", { content: "# after restart" }, 201, { "X-Inkstone-Origin": "restarted" });
		await changed(socket, "restarted");
		await socket.close();
	});
};

export default scenario;
