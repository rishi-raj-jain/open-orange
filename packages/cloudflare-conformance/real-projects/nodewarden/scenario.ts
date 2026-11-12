import assert from "node:assert/strict";

import type { Scenario, TestSocket } from "../../src/real-projects/scenario.js";

const separator = "\x1e";
const email = "scenario@example.com";
const password = "client-side-master-password-hash";
const encrypted = "2.aaaaaaaaaaaaaaaaaaaaaa==|bbbbbbbbbbbbbbbbbbbbbb==|cccccccccccccccccccccc==";

const scenario: Scenario = async (t) => {
	let accessToken = "";
	const authorized = () => ({ authorization: `Bearer ${accessToken}` });
	const logIn = async () => {
		const body = new URLSearchParams({
			grant_type: "password",
			username: email,
			password,
			scope: "api offline_access",
			client_id: "web",
			deviceType: "9",
			deviceIdentifier: "0f0f0f0f-0000-4000-8000-000000000001",
			deviceName: "scenario",
		});
		const token = await t.json<{ access_token: string }>("/identity/connect/token", { method: "POST", body });
		accessToken = token.access_token;
	};
	const negotiate = async () => {
		const answer = await t.json<{ connectionToken: string }>("/notifications/hub/negotiate", {
			method: "POST",
			headers: authorized(),
		});
		return answer.connectionToken;
	};
	const openHub = async (ticket: string): Promise<TestSocket> => {
		const socket = await t.webSocket(`/notifications/hub?id=${encodeURIComponent(ticket)}`);
		socket.send(`${JSON.stringify({ protocol: "json", version: 1 })}${separator}`);
		assert.equal(await socket.next(), `{}${separator}`);
		return socket;
	};
	const createFolder = async () => {
		const folder = await t.json<{ id?: string; Id?: string }>("/api/folders", {
			method: "POST",
			headers: { ...authorized(), "content-type": "application/json" },
			body: JSON.stringify({ name: encrypted }),
		});
		const id = folder.id ?? folder.Id;
		assert.ok(id, "the created folder has an id");
		return id;
	};
	const folderNotice = (socket: TestSocket, id: string) =>
		socket.until((text) => text.includes('"target":"ReceiveMessage"') && text.includes('"Type":7') && text.includes(id));
	const syncedFolders = async () => JSON.stringify(await t.json("/api/sync", { headers: authorized() }));

	const folders: string[] = [];

	await t.step("serves the web vault and its bootstrap", "http", async () => {
		assert.match(await t.text("/"), /NodeWarden/);
		const bootstrap = await t.json<{ jwtUnsafeReason: string | null; registrationInviteRequired: boolean }>("/api/web-bootstrap");
		assert.equal(bootstrap.jwtUnsafeReason, null);
		assert.equal(bootstrap.registrationInviteRequired, false);
	});

	await t.step("the first account registers in D1 and logs in", "binding", async () => {
		const registered = await t.json<{ role: string }>("/api/accounts/register", {
			method: "POST",
			headers: { "content-type": "application/json", origin: t.origin },
			body: JSON.stringify({
				email,
				name: "Scenario",
				masterPasswordHash: password,
				key: encrypted,
				kdf: 0,
				kdfIterations: 600_000,
				keys: { publicKey: "scenario-public-key", encryptedPrivateKey: encrypted },
			}),
		});
		assert.equal(registered.role, "admin");
		await logIn();
	});

	await t.step("a negotiated connection ticket opens the hub only once", "do-state", async () => {
		const ticket = await negotiate();
		const socket = await openHub(ticket);
		await socket.close();
		await assert.rejects(openHub(ticket), /HTTP 401/);
	});

	await t.step("a folder created over HTTP reaches the client's hub socket", "websocket", async () => {
		const socket = await openHub(await negotiate());
		const id = await createFolder();
		folders.push(id);
		await folderNotice(socket, id);
		await socket.close();
		assert.ok((await syncedFolders()).includes(id), "the sync response has the folder");
	});

	await t.step("a ticket stored in the hub survives the hub's sleep", "sleep", async () => {
		const ticket = await negotiate();
		await t.waitForSleep();
		const socket = await openHub(ticket);
		await socket.close();
	});

	await t.step("a client stays connected while the hub hibernates, and the next notification reaches it", "sleep", async () => {
		await t.waitForSleep();
		const socket = await openHub(await negotiate());
		await t.waitForSleep();
		const id = await createFolder();
		folders.push(id);
		await folderNotice(socket, id);
		await socket.close();
	});

	await t.step("the vault and login survive an orange dev and engine restart, and the hub still works", "restart", async () => {
		await t.restart();
		const synced = await syncedFolders();
		for (const id of folders) assert.ok(synced.includes(id), `the sync response has folder ${id}`);
		await logIn();
		const socket = await openHub(await negotiate());
		const id = await createFolder();
		await folderNotice(socket, id);
		await socket.close();
	});
};

export default scenario;
