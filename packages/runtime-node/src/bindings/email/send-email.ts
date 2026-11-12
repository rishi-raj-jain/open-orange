import MailComposer from "nodemailer/lib/mail-composer/index.js";

import type { RuntimeSendEmailBinding } from "../../process-protocol.js";
import { isRecord } from "../unknown-values.js";
import type { EmailEnvelope, SmtpSender } from "./smtp.js";

// The raw MIME of an `EmailMessage` from cloudflare:email, which any copy of that module sets.
const rawKey = Symbol.for("open-orange.email-message.raw");

export interface EmailSendResult {
	messageId: string;
}

// An `EmailMessage(from, to, raw)`: the Worker built the MIME itself.
export async function emailMessageParts(
	message: unknown,
): Promise<{ envelope: EmailEnvelope; raw: Uint8Array } | undefined> {
	if (!isRecord(message) || !(rawKey in message)) return undefined;
	const raw: unknown = Reflect.get(message, rawKey);
	const bytes =
		typeof raw === "string"
			? new TextEncoder().encode(raw)
			: new Uint8Array(await new Response(raw as ReadableStream).arrayBuffer());
	return { envelope: { from: String(message.from), to: [String(message.to)] }, raw: bytes };
}

export function messageIdOf(raw: Uint8Array): string {
	const head = Buffer.from(raw.subarray(0, 64 * 1024)).toString("latin1");
	const end = head.search(/\r?\n\r?\n/);
	const match = /^message-id[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(end === -1 ? head : head.slice(0, end));
	return match?.[1] ?? "";
}

function nodemailerAddress(value: unknown, field: string): string | { address: string; name: string } {
	if (typeof value === "string") return value;
	if (isRecord(value) && typeof value.email === "string") {
		return { address: value.email, name: typeof value.name === "string" ? value.name : "" };
	}
	throw new TypeError(`send(): ${field} must be an address or { email, name }`);
}

function addressList(value: unknown, field: string): (string | { address: string; name: string })[] | undefined {
	if (value === undefined) return undefined;
	return (Array.isArray(value) ? value : [value]).map((entry: unknown) => nodemailerAddress(entry, field));
}

// The object that Cloudflare's Email Service takes: `send({ from, to, subject, text, html, ... })`.
// https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
async function composedMessage(message: unknown): Promise<{ envelope: EmailEnvelope; raw: Uint8Array; messageId: string }> {
	if (!isRecord(message)) throw new TypeError("send() takes an EmailMessage or a message object");
	if (message.from === undefined) throw new TypeError("send(): from is required");
	if (message.to === undefined) throw new TypeError("send(): to is required");
	if (typeof message.subject !== "string") throw new TypeError("send(): subject is required");
	if (typeof message.text !== "string" && typeof message.html !== "string") {
		throw new TypeError("send(): text or html is required");
	}
	const attachments = Array.isArray(message.attachments)
		? message.attachments.map((attachment: unknown) => {
				if (!isRecord(attachment) || typeof attachment.content !== "string" || typeof attachment.filename !== "string") {
					throw new TypeError("send(): each attachment needs base64 content and a filename");
				}
				return {
					content: Buffer.from(attachment.content, "base64"),
					filename: attachment.filename,
					...(typeof attachment.type === "string" ? { contentType: attachment.type } : {}),
					...(attachment.disposition === "inline" ? { contentDisposition: "inline" as const } : {}),
					...(typeof attachment.contentId === "string" ? { cid: attachment.contentId } : {}),
				};
			})
		: undefined;
	const mail = new MailComposer({
		from: nodemailerAddress(message.from, "from"),
		to: addressList(message.to, "to"),
		cc: addressList(message.cc, "cc"),
		bcc: addressList(message.bcc, "bcc"),
		...(message.replyTo === undefined ? {} : { replyTo: nodemailerAddress(message.replyTo, "replyTo") }),
		subject: message.subject,
		...(typeof message.text === "string" ? { text: message.text } : {}),
		...(typeof message.html === "string" ? { html: message.html } : {}),
		...(isRecord(message.headers) ? { headers: message.headers as Record<string, string> } : {}),
		...(attachments === undefined ? {} : { attachments }),
	}).compile();
	const envelope = mail.getEnvelope();
	const raw = await new Promise<Buffer>((resolveBuild, rejectBuild) =>
		mail.build((error, built) => (error === null ? resolveBuild(built) : rejectBuild(error))),
	);
	if (envelope.from === false) throw new TypeError("send(): from must be an email address");
	return { envelope: { from: envelope.from, to: envelope.to }, messageId: mail.messageId(), raw };
}

// `env.EMAIL`. It sends through the configured SMTP server and keeps the address limits of the
// binding's configuration, which Cloudflare also enforces.
// https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/
export class SendEmail {
	readonly #binding: RuntimeSendEmailBinding;
	readonly #sender: SmtpSender;

	constructor(binding: RuntimeSendEmailBinding, sender: SmtpSender) {
		this.#binding = binding;
		this.#sender = sender;
	}

	async send(message: unknown): Promise<EmailSendResult> {
		const fromEmailMessage = await emailMessageParts(message);
		const { envelope, raw, messageId } =
			fromEmailMessage === undefined
				? await composedMessage(message)
				: { ...fromEmailMessage, messageId: messageIdOf(fromEmailMessage.raw) };
		this.#check(envelope);
		await this.#sender.send(envelope, raw);
		return { messageId };
	}

	#check(envelope: EmailEnvelope): void {
		const name = JSON.stringify(this.#binding.binding);
		const { allowedDestinationAddresses, allowedSenderAddresses, destinationAddress } = this.#binding;
		if (allowedSenderAddresses !== undefined && !allowedSenderAddresses.includes(envelope.from)) {
			throw new Error(`Send Email binding ${name} may not send from ${envelope.from}: it is not in allowed_sender_addresses`);
		}
		for (const recipient of envelope.to) {
			if (destinationAddress !== undefined && recipient !== destinationAddress) {
				throw new Error(`Send Email binding ${name} may only send to its destination_address, not ${recipient}`);
			}
			if (allowedDestinationAddresses !== undefined && !allowedDestinationAddresses.includes(recipient)) {
				throw new Error(`Send Email binding ${name} may not send to ${recipient}: it is not in allowed_destination_addresses`);
			}
		}
	}
}
