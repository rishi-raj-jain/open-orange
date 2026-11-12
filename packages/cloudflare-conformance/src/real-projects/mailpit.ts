import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// A real SMTP server for scenarios that send mail: Mailpit in Docker, on fixed local ports so
// that a project's devVars can name it. Scenarios find their own messages by a token in the
// subject, so several runs can share one Mailpit.
// https://mailpit.axllent.org/docs/api-v1/

/** The value for a project's `ORANGE_EMAIL_SMTP_URL`. */
export const mailpitSmtpUrl = "smtp://127.0.0.1:11025";

const api = "http://127.0.0.1:18025/api/v1";
const container = "oo-conformance-mailpit";
const image = "axllent/mailpit:v1.27";

export interface MailpitAddress {
	Address: string;
	Name: string;
}

export interface MailpitMessage {
	ID: string;
	Subject: string;
	From: MailpitAddress;
	To: MailpitAddress[];
	Cc: MailpitAddress[];
	Bcc: MailpitAddress[];
	Text: string;
	HTML: string;
	Attachments: { ContentType: string; FileName: string }[];
}

async function answers(): Promise<boolean> {
	try {
		return (await fetch(`${api}/info`)).ok;
	} catch {
		return false;
	}
}

/** Starts Mailpit unless it already runs, and leaves it running. `docker rm -f oo-conformance-mailpit` stops it. */
export async function ensureMailpit(): Promise<void> {
	if (await answers()) return;
	const run = spawnSync(
		"docker",
		["run", "-d", "--rm", "--name", container, "-p", "127.0.0.1:11025:1025", "-p", "127.0.0.1:18025:8025", image],
		{ encoding: "utf8" },
	);
	// Another scenario can start it first. Then the name is taken, and the API answers soon.
	if (run.status !== 0 && !run.stderr.includes("is already in use")) {
		throw new Error(`Mailpit did not start: ${run.stderr.trim() || run.error?.message}`);
	}
	for (let attempt = 0; attempt < 150; attempt++) {
		if (await answers()) return;
		await delay(100);
	}
	throw new Error("Mailpit did not answer on 127.0.0.1:18025");
}

/** Messages whose subject has `token`, waiting up to `timeoutMs` for at least `count`. */
export async function mailWithSubject(token: string, count = 1, timeoutMs = 10_000): Promise<MailpitMessage[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const response = await fetch(`${api}/search?query=${encodeURIComponent(`subject:"${token}"`)}`);
		const { messages = [] } = (await response.json()) as { messages?: { ID: string }[] };
		if (messages.length >= count || Date.now() >= deadline) {
			return Promise.all(messages.map(async ({ ID }) => (await fetch(`${api}/message/${ID}`)).json() as Promise<MailpitMessage>));
		}
		await delay(200);
	}
}

/** The headers of one message, as Mailpit received them. */
export async function mailHeaders(id: string): Promise<Record<string, string[]>> {
	return (await fetch(`${api}/message/${id}/headers`)).json() as Promise<Record<string, string[]>>;
}
