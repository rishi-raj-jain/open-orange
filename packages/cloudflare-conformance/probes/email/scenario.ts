import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { ensureMailpit, mailHeaders, mailWithSubject } from "../../src/real-projects/mailpit.js";
import type { Scenario, ScenarioContext } from "../../src/real-projects/scenario.js";

// Send Email and inbound email through orange dev, with Mailpit as the SMTP server that
// ORANGE_EMAIL_SMTP_URL names. Each step finds its own messages by a fresh token in the subject.
const secret = "local-only-inbound-secret";

function inbound(t: ScenarioContext, to: string, subject: string, authorization = `Bearer ${secret}`): Promise<Response> {
	const raw = [
		"From: Alice <alice@example.org>",
		`To: ${to}`,
		`Subject: ${subject}`,
		`Message-ID: <${randomUUID()}@example.org>`,
		"Content-Type: text/plain",
		"",
		"Hello.",
		"",
	].join("\r\n");
	const query = new URLSearchParams({ from: "alice@example.org", to });
	return t.fetch(`/cdn-cgi/handler/email?${query}`, { method: "POST", headers: { authorization }, body: raw });
}

const scenario: Scenario = async (t) => {
	await ensureMailpit();

	await t.step("Send Email: an EmailMessage with its own MIME arrives over SMTP", "binding", async () => {
		const token = randomUUID();
		await t.json(`/raw?token=${token}`);
		const [message] = await mailWithSubject(token);
		assert.ok(message, "Mailpit got no message");
		assert.equal(message.From.Address, "sender@example.com");
		assert.deepEqual(message.To.map((to) => to.Address), ["inbox@example.com"]);
	});

	await t.step("Send Email: a message object arrives with its Cc, Bcc, and attachment", "binding", async () => {
		const token = randomUUID();
		const { messageId } = await t.json<{ messageId: string }>(`/object?token=${token}`);
		assert.ok(messageId.length > 0);
		const [message] = await mailWithSubject(token);
		assert.ok(message, "Mailpit got no message");
		assert.deepEqual(message.Cc.map((cc) => cc.Address), ["copy@example.com"]);
		// Bcc goes through the SMTP envelope. Mailpit lists envelope-only recipients as Bcc.
		assert.deepEqual(message.Bcc.map((bcc) => bcc.Address), ["hidden@example.com"]);
		assert.deepEqual(message.Attachments.map((file) => file.FileName), ["note.txt"]);
	});

	await t.step("Send Email: a recipient outside allowed_destination_addresses is refused, and nothing is sent", "binding", async () => {
		const token = randomUUID();
		const refused = await t.text(`/stranger?token=${token}`, undefined, 500);
		assert.match(refused, /stranger@example\.com/);
		assert.deepEqual(await mailWithSubject(token, 1, 2_000), []);
	});

	await t.step("Inbound email: a POSTed message runs email(), and forward() sends it on over SMTP", "binding", async () => {
		const token = randomUUID();
		const response = await inbound(t, "forward@example.com", token);
		assert.equal(response.status, 200, await response.text());
		const [message] = await mailWithSubject(token);
		assert.ok(message, "Mailpit got no forwarded message");
		assert.deepEqual(message.To.map((to) => to.Address), ["forward@example.com"]);
		assert.deepEqual((await mailHeaders(message.ID))["X-Probe"], ["forwarded"]);
	});

	await t.step("Inbound email: reply() sends the Worker's reply, with In-Reply-To", "binding", async () => {
		const token = randomUUID();
		const response = await inbound(t, "reply@example.com", token);
		assert.equal(response.status, 200, await response.text());
		const [reply] = await mailWithSubject(`Re: ${token}`);
		assert.ok(reply, "Mailpit got no reply");
		assert.deepEqual(reply.To.map((to) => to.Address), ["alice@example.org"]);
		assert.match((await mailHeaders(reply.ID))["In-Reply-To"]?.[0] ?? "", /@example\.org>$/);
	});

	await t.step("Inbound email: setReject() answers 400", "binding", async () => {
		const response = await inbound(t, "nobody@example.com", randomUUID());
		assert.equal(response.status, 400, await response.text());
	});

	await t.step("Inbound email: a wrong secret gets 401, and email() does not run", "binding", async () => {
		const token = randomUUID();
		const response = await inbound(t, "forward@example.com", token, "Bearer wrong-secret");
		assert.equal(response.status, 401, await response.text());
		assert.deepEqual(await mailWithSubject(token, 1, 2_000), []);
	});
};

export default scenario;
