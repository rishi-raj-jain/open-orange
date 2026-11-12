import { EmailMessage } from "cloudflare:email";

// Sends mail both ways a Worker can, and handles inbound mail by the address it was sent to.
// Each request carries a token, which goes in the subject so the scenario can find its messages.
function mime(from: string, to: string, subject: string, extra: string[] = []): string {
	return [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${crypto.randomUUID()}@example.com>`, ...extra, "Content-Type: text/plain; charset=utf-8", "", "body", ""].join("\r\n");
}

export default {
	async email(message: any): Promise<void> {
		const subject = message.headers.get("subject") ?? "";
		if (message.to.startsWith("forward@")) {
			await message.forward("inbox@example.com", new Headers({ "X-Probe": "forwarded" }));
		} else if (message.to.startsWith("reply@")) {
			const inReplyTo = message.headers.get("message-id");
			await message.reply(new EmailMessage(message.to, message.from, mime(message.to, message.from, `Re: ${subject}`, [`In-Reply-To: ${inReplyTo}`])));
		} else {
			message.setReject("No such mailbox");
		}
	},
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url);
		const token = url.searchParams.get("token") ?? "";
		try {
			if (url.pathname === "/raw") {
				const subject = `raw ${token}`;
				return Response.json(await env.MAIL.send(new EmailMessage("sender@example.com", "inbox@example.com", mime("sender@example.com", "inbox@example.com", subject))));
			}
			if (url.pathname === "/object") {
				return Response.json(
					await env.MAIL.send({
						from: { email: "sender@example.com", name: "Sender" },
						to: "inbox@example.com",
						cc: "copy@example.com",
						bcc: "hidden@example.com",
						subject: `object ${token}`,
						text: "text body",
						html: "<p>html body</p>",
						attachments: [{ content: btoa("attached text"), filename: "note.txt", type: "text/plain", disposition: "attachment" }],
					}),
				);
			}
			if (url.pathname === "/stranger") {
				return Response.json(await env.MAIL.send({ from: "sender@example.com", to: "stranger@example.com", subject: `stranger ${token}`, text: "no" }));
			}
		} catch (error) {
			return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
		}
		return new Response("not found", { status: 404 });
	},
};
