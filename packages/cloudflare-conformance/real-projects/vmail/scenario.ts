import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";

import type { Scenario, ScenarioContext } from "../../src/real-projects/scenario.js";

const json = { "content-type": "application/json" };

// The web client calls /api/verify to create a mailbox, and sends the token as a bearer token after that.
async function createMailbox(t: ScenarioContext): Promise<{ mailbox: string; mailboxToken: string }> {
	const created = await t.json<{ success: boolean; mailbox: string; mailboxToken: string }>("/api/verify", {
		method: "POST",
		headers: json,
		body: JSON.stringify({ domain: "example.test" }),
	});
	assert.equal(created.success, true);
	assert.match(created.mailbox, /@example\.test$/);
	return created;
}

const bearer = (token: string) => ({ ...json, authorization: `Bearer ${token}` });

const scenario: Scenario = async (t) => {
	await t.step("serves the app and its config", "http", async () => {
		assert.match(await t.text("/"), /<html/);
		const config = await t.json<{ emailDomain: string[]; setupRequired: boolean; authEnabled: boolean }>("/config");
		assert.deepEqual(config.emailDomain, ["example.test"]);
		assert.equal(config.setupRequired, false);
		assert.equal(config.authEnabled, false);
	});

	let mailbox = "";
	let token = "";
	await t.step("a created mailbox is active in its ledger, and another token is refused", "do-state", async () => {
		({ mailbox, mailboxToken: token } = await createMailbox(t));
		assert.deepEqual(
			await t.json("/api/emails", { method: "POST", headers: bearer(token), body: JSON.stringify({ address: mailbox }) }),
			[],
		);
		const login = await t.json<{ address: string }>("/api/login", { method: "POST", headers: json, body: JSON.stringify({ password: token }) });
		assert.equal(login.address, mailbox);
		await t.json("/api/emails", { method: "POST", headers: bearer("not-a-token"), body: JSON.stringify({ address: mailbox }) }, 401);
	});

	await t.step("a mailbox's token can be renewed, and the new token works", "do-state", async () => {
		const { mailboxToken } = await t.json<{ mailboxToken: string }>("/api/mailbox-token/refresh", { method: "POST", headers: bearer(token) });
		const login = await t.json<{ address: string }>("/api/login", { method: "POST", headers: json, body: JSON.stringify({ password: mailboxToken }) });
		assert.equal(login.address, mailbox);
		token = mailboxToken;
	});

	// The local route that `wrangler dev` serves for Email Workers. ORANGE_EMAIL_INBOUND_SECRET is not set, so orange dev needs none.
	const deliver = (to: string, subject: string) => {
		const raw = [
			"From: Friend <friend@example.net>",
			`To: ${to}`,
			`Subject: ${subject}`,
			`Message-ID: <${randomUUID()}@example.net>`,
			"Content-Type: text/plain",
			"",
			"Your code is 123456.",
			"",
		].join("\r\n");
		return t.fetch(`/cdn-cgi/handler/email?${new URLSearchParams({ from: "friend@example.net", to })}`, { method: "POST", body: raw });
	};

	await t.step("an inbound email goes through email() into the mailbox, and the mailbox lists it", "binding", async () => {
		const delivered = await deliver(mailbox, "Your code");
		assert.equal(delivered.status, 200, await delivered.text());
		const listed = await t.json<{ id: string; subject: string }[]>("/api/emails", { method: "POST", headers: bearer(token), body: JSON.stringify({ address: mailbox }) });
		assert.deepEqual(listed.map((email) => email.subject), ["Your code"]);
		const email = await t.json<{ text: string }>(`/api/emails/${listed[0]!.id}`, { headers: bearer(token) });
		assert.match(email.text, /123456/);
	});

	await t.step("an email to a mailbox that was never created is rejected", "binding", async () => {
		const rejected = await deliver("nobody@example.test", "Lost");
		assert.equal(rejected.status, 400, await rejected.text());
	});

	// /api/send needs a session from GitHub or Google sign-in, so this needs real OAuth apps.
	t.needsSecrets("a signed-in mailbox sends an email through the send_email binding", "binding", [
		"GITHUB_CLIENT_ID",
		"GITHUB_CLIENT_SECRET",
		"GOOGLE_CLIENT_ID",
		"GOOGLE_CLIENT_SECRET",
	]);

	await t.step("the ledger counts a mailbox's requests atomically, and refuses them past its limit", "do-state", async () => {
		const busy = await createMailbox(t);
		// `web-minute` allows 30 per aligned minute, so 61 requests must meet the limit even across a minute boundary.
		const responses = await Promise.all(
			Array.from({ length: 61 }, () => t.fetch("/api/emails/meta", { method: "POST", headers: bearer(busy.mailboxToken) })),
		);
		const statuses = responses.map((response) => response.status);
		const allowed = statuses.filter((status) => status === 200).length;
		const refused = responses.filter((response) => response.status === 429);
		assert.equal(allowed + refused.length, 61, `unexpected statuses: ${statuses.join(",")}`);
		assert.ok(allowed >= 30 && allowed <= 60, `${allowed} requests were allowed`);
		const body = await refused[0]!.json() as { error: { code: string } };
		assert.equal(body.error.code, "QUOTA_EXCEEDED");
		assert.ok(Number(refused[0]!.headers.get("retry-after")) > 0);
	});

	await t.step("a mailbox is still active after its ledger sleeps", "sleep", async () => {
		await t.waitForSleep();
		const login = await t.json<{ address: string }>("/api/login", { method: "POST", headers: json, body: JSON.stringify({ password: token }) });
		assert.equal(login.address, mailbox);
	});

	await t.step("a mailbox is still active after a restart, and its D1 mailbox still reads", "restart", async () => {
		await t.restart();
		const login = await t.json<{ address: string }>("/api/login", { method: "POST", headers: json, body: JSON.stringify({ password: token }) });
		assert.equal(login.address, mailbox);
		const listed = await t.json<{ subject: string }[]>("/api/emails", { method: "POST", headers: bearer(token), body: JSON.stringify({ address: mailbox }) });
		assert.deepEqual(listed.map((email) => email.subject), ["Your code"]);
	});
};

export default scenario;
