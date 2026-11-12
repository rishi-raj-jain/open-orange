import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { ensureMailpit, mailHeaders, mailWithSubject } from "../../src/real-projects/mailpit.js";
import type { Scenario } from "../../src/real-projects/scenario.js";

const accessPort = 38917;
const issuer = `http://127.0.0.1:${accessPort}`;
const audience = "corpus-local-access-audience";
const mailbox = "hello@example.com";
const base = `/api/v1/mailboxes/${encodeURIComponent(mailbox)}`;

/** Stands in for Cloudflare Access: serves the certs URL, and signs the JWT Access would add. */
function startAccess() {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: "jwk" }), kid: "corpus", alg: "RS256", use: "sig" };
	const server = createServer((_request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ keys: [jwk] }));
	});
	server.listen(accessPort, "127.0.0.1");
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const body = `${encode({ alg: "RS256", kid: "corpus", typ: "JWT" })}.${encode({
		iss: issuer,
		aud: audience,
		sub: "corpus",
		exp: Math.floor(Date.now() / 1000) + 3600,
	})}`;
	const signature = createSign("RSA-SHA256").update(body).sign(privateKey).toString("base64url");
	return { token: `${body}.${signature}`, stop: () => server.close() };
}

const scenario: Scenario = async (t) => {
	await ensureMailpit();
	const access = startAccess();
	const headers = { "cf-access-jwt-assertion": access.token, "content-type": "application/json" };
	const api = <T = any>(path: string, init: RequestInit = {}, status = 200) =>
		t.json<T>(path, { ...init, headers }, status);

	try {
		await t.step("the app page renders, behind Access", "http", async () => {
			await t.text("/", undefined, 403);
			const page = await t.text("/", { headers });
			assert.match(page, /<div|<html/i);
			assert.deepEqual(await api("/api/v1/config"), { domains: ["example.com"], emailAddresses: [] });
		});

		let draftId = "";
		await t.step("a mailbox is created, and a draft is kept in its Durable Object", "do-state", async () => {
			await api(
				"/api/v1/mailboxes",
				{ method: "POST", body: JSON.stringify({ email: mailbox, name: "Hello" }) },
				201,
			);
			const listed = await api<{ id: string }[]>("/api/v1/mailboxes");
			assert.ok(listed.some((entry) => entry.id === mailbox));
			const draft = await api(
				`${base}/drafts`,
				{ method: "POST", body: JSON.stringify({ to: "friend@example.net", subject: "Lunch", body: "<p>Noon?</p>" }) },
				201,
			);
			draftId = draft.id;
			const drafts = await api(`${base}/emails?folder=draft`);
			assert.equal(drafts.totalCount, 1);
			assert.equal(drafts.emails[0].subject, "Lunch");
		});

		await t.step("a sent email lands in Sent, and a custom folder and search see it", "do-state", async () => {
			const sent = await api(
				`${base}/emails`,
				{
					method: "POST",
					body: JSON.stringify({
						to: "friend@example.net",
						from: { email: mailbox, name: "Hello" },
						subject: "Quarterly report",
						html: "<p>The numbers are in.</p>",
					}),
				},
				202,
			);
			assert.equal(sent.status, "sent");
			await api(`${base}/folders`, { method: "POST", body: JSON.stringify({ name: "Reports" }) }, 201);
			await api(`${base}/emails/${sent.id}/move`, { method: "POST", body: JSON.stringify({ folderId: "reports" }) });
			const moved = await api(`${base}/emails?folder=reports`);
			assert.equal(moved.totalCount, 1);
			await api(`${base}/emails/${sent.id}`, { method: "PUT", body: JSON.stringify({ starred: true }) });
			const found = await api(`${base}/search?query=Quarterly`);
			assert.equal(found.totalCount, 1);
			assert.equal(found.emails[0].starred, true);
		});

		await t.step("an MCP client lists the same mailbox through the EmailMCP object", "do-state", async () => {
			const mcpHeaders = { ...headers, accept: "application/json, text/event-stream" };
			const parse = (text: string) => {
				const data = text.split("\n").find((line) => line.startsWith("data: "));
				return JSON.parse(data === undefined ? text : data.slice(6));
			};
			const initialized = await t.fetch("/mcp", {
				method: "POST",
				headers: mcpHeaders,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "corpus", version: "1" } },
				}),
			});
			const initializedBody = await initialized.text();
			assert.equal(initialized.status, 200, initializedBody);
			assert.equal(parse(initializedBody).result.serverInfo.name, "agentic-inbox");
			const session = initialized.headers.get("mcp-session-id");
			assert.ok(session);
			const withSession = { ...mcpHeaders, "mcp-session-id": session };
			await t.fetch("/mcp", {
				method: "POST",
				headers: withSession,
				body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
			});
			const called = await t.fetch("/mcp", {
				method: "POST",
				headers: withSession,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "list_emails", arguments: { mailboxId: mailbox, folder: "reports" } },
				}),
			});
			const calledBody = await called.text();
			assert.equal(called.status, 200, calledBody);
			assert.match(parse(calledBody).result.content[0].text, /Quarterly report/);
		});

		await t.step("an inbound email goes through the Worker's email() handler into the inbox", "binding", async () => {
			const raw = [
				"From: Friend <friend@example.net>",
				`To: ${mailbox}`,
				"Subject: Are you there",
				"Message-ID: <inbound-1@example.net>",
				"Content-Type: text/plain",
				"",
				"Checking in.",
				"",
			].join("\r\n");
			// The local route that `wrangler dev` serves for Email Workers.
			const query = new URLSearchParams({ from: "friend@example.net", to: mailbox });
			await t.fetch(`/cdn-cgi/handler/email?${query}`, { method: "POST", headers, body: raw });
			const inbox = await api(`${base}/emails?folder=inbox`);
			assert.equal(inbox.totalCount, 1);
			assert.equal(inbox.emails[0].subject, "Are you there");
		});

		// ORANGE_EMAIL_SMTP_URL points the send_email binding at Mailpit. The app sends in waitUntil, after it answers.
		await t.step("a sent email and a threaded reply are delivered over SMTP through the send_email binding", "binding", async () => {
			const token = randomUUID();
			const send = (subject: string, extra: object = {}) =>
				api(
					`${base}/emails`,
					{ method: "POST", body: JSON.stringify({ to: "friend@example.net", from: { email: mailbox, name: "Hello" }, subject, text: "Here.", ...extra }) },
					202,
				);
			await send(`Status ${token}`);
			const [sent] = await mailWithSubject(`Status ${token}`);
			assert.ok(sent, "Mailpit got no message");
			assert.equal(sent.From.Address, mailbox);
			assert.deepEqual(sent.To.map((to) => to.Address), ["friend@example.net"]);
			await send(`Re: Are you there ${token}`, { in_reply_to: "inbound-1@example.net", references: ["inbound-1@example.net"] });
			const [reply] = await mailWithSubject(`Re: Are you there ${token}`);
			assert.ok(reply, "Mailpit got no reply");
			assert.deepEqual((await mailHeaders(reply.ID))["In-Reply-To"], ["<inbound-1@example.net>"]);
		});

		await t.step("the agent side panel opens its WebSocket and gets its state", "websocket", async () => {
			const socket = await t.webSocket(`/agents/email-agent/${encodeURIComponent(mailbox)}`, { headers });
			const first = await socket.until((text) => text.includes("cf_agent_"));
			assert.match(first, /cf_agent_/);
			await socket.close();
		});

		const assertKept = async () => {
			const drafts = await api(`${base}/emails?folder=draft`);
			assert.equal(drafts.emails[0].id, draftId);
			const moved = await api(`${base}/emails?folder=reports`);
			assert.equal(moved.emails[0].subject, "Quarterly report");
			assert.equal(moved.emails[0].starred, true);
			const listed = await api<{ id: string }[]>("/api/v1/mailboxes");
			assert.ok(listed.some((entry) => entry.id === mailbox));
		};

		await t.step("the mailbox survives the object's sleep", "sleep", async () => {
			await t.waitForSleep();
			await assertKept();
		});

		await t.step("the mailbox survives a restart", "restart", async () => {
			await t.restart();
			await assertKept();
		});

		t.needsSecrets("the agent reads the inbox and drafts a reply with Workers AI", "websocket", ["OPENROUTER_API_KEY"]);
	} finally {
		access.stop();
	}
};

export default scenario;
