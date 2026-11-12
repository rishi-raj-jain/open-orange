import { createTransport, type Transporter } from "nodemailer";

import type { RuntimeSettings } from "../../internal/runtime-settings.js";

// Orange sends mail through one SMTP server that the user configures, as
// `smtp://user:password@smtp.example.com:587` (STARTTLS when the server offers it) or
// `smtps://user:password@smtp.example.com:465` (TLS from the start). Send Email bindings,
// `message.forward()`, and `message.reply()` all use it.
export const smtpUrlSetting = "ORANGE_EMAIL_SMTP_URL";

export interface EmailEnvelope {
	from: string;
	to: readonly string[];
}

export interface SmtpSender {
	send(envelope: EmailEnvelope, raw: Uint8Array): Promise<void>;
}

const transports = new Map<string, Transporter>();

export function smtpSenderFromSettings(settings: RuntimeSettings): SmtpSender | undefined {
	const url = settings[smtpUrlSetting];
	if (url === undefined || url.length === 0) return undefined;
	let server: URL;
	try {
		server = new URL(url);
	} catch {
		throw new Error(`${smtpUrlSetting} must be a URL such as smtp://user:password@smtp.example.com:587`);
	}
	if (server.protocol !== "smtp:" && server.protocol !== "smtps:") {
		throw new Error(`${smtpUrlSetting} must start with smtp:// or smtps://, not ${server.protocol}//`);
	}
	// Errors name the server but never its credentials.
	const where = `${server.protocol}//${server.host}`;
	let transport = transports.get(url);
	if (transport === undefined) {
		transport = createTransport(url);
		transports.set(url, transport);
	}
	const shared = transport;
	return {
		async send(envelope, raw): Promise<void> {
			try {
				await shared.sendMail({ envelope: { from: envelope.from, to: [...envelope.to] }, raw: Buffer.from(raw) });
			} catch (error: unknown) {
				throw new Error(
					`Sending email through ${where} failed: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
		},
	};
}
