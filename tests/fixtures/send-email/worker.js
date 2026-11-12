import { EmailMessage } from "cloudflare:email";

// Sends mail both ways a Worker can: an EmailMessage with its own MIME, as vmail does, and the
// Email Service object, as agentic-inbox does. Errors come back as the response text.
const raw = [
	"From: Sender <sender@example.com>",
	"To: inbox@example.com",
	"Subject: raw hello",
	"Message-ID: <raw-1@example.com>",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"raw body",
	"",
].join("\r\n");

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		try {
			if (pathname === "/raw") {
				return Response.json(await env.MAIL.send(new EmailMessage("sender@example.com", "inbox@example.com", raw)));
			}
			if (pathname === "/object") {
				return Response.json(
					await env.MAIL.send({
						attachments: [{ content: btoa("attached text"), disposition: "attachment", filename: "note.txt", type: "text/plain" }],
						bcc: "hidden@example.com",
						cc: "copy@example.com",
						from: { email: "sender@example.com", name: "Sender" },
						html: "<p>html body</p>",
						subject: "object hello",
						text: "text body",
						to: "inbox@example.com",
					}),
				);
			}
			if (pathname === "/stranger") {
				return Response.json(
					await env.MAIL.send({ from: "sender@example.com", subject: "nope", text: "nope", to: "stranger@example.com" }),
				);
			}
		} catch (error) {
			return new Response(String(error?.message ?? error), { status: 500 });
		}
		return new Response("not found", { status: 404 });
	},
};
