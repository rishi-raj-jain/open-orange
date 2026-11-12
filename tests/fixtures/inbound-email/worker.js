import { EmailMessage } from "cloudflare:email";

// Forwards each message to the team, and replies to its sender.
export default {
	async email(message) {
		const subject = message.headers.get("subject") ?? "";
		await message.forward("team@example.com", new Headers({ "X-Orange": "forwarded" }));
		const reply = [
			`From: ${message.to}`,
			`To: ${message.from}`,
			`Subject: Re: ${subject}`,
			`In-Reply-To: ${message.headers.get("message-id")}`,
			"Message-ID: <reply-1@example.com>",
			"",
			`Got ${message.rawSize} bytes.`,
			"",
		].join("\r\n");
		await message.reply(new EmailMessage(message.to, message.from, reply));
	},
	fetch() {
		return new Response("the Worker's own fetch()", { status: 404 });
	},
};
