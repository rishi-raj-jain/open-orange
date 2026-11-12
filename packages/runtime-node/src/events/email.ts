import { timingSafeEqual } from "node:crypto";

import { createExecutionContext, runInExecutionContext, type ExecutionContext } from "../context.js";
import { Headers, type Request, Response } from "../globals/http.js";
import { isWorkerEntrypointClass } from "../modules/cloudflare-workers/worker-entrypoint.js";
import { emailMessageParts, type EmailSendResult, messageIdOf } from "../bindings/email/send-email.js";
import { type SmtpSender, smtpSenderFromSettings, smtpUrlSetting } from "../bindings/email/smtp.js";
import { isRecord } from "../bindings/unknown-values.js";
import { runtimeSettings } from "../internal/runtime-settings.js";

export type EmailHandler = (
	message: ForwardableEmailMessage,
	environment: object,
	context: ExecutionContext,
) => unknown;

// The `email` handler of the Worker's default export: a method of a WorkerEntrypoint class, or a
// function on the exported object.
export function defaultEmailHandler(defaultExport: unknown): EmailHandler | undefined {
	if (isWorkerEntrypointClass(defaultExport)) {
		if (typeof Reflect.get(defaultExport.prototype, "email") !== "function") return undefined;
		return (message, environment, context) => {
			const instance = Reflect.construct(defaultExport, [context, environment]);
			return Reflect.apply(Reflect.get(instance, "email"), instance, [message]);
		};
	}
	if (!isRecord(defaultExport)) return undefined;
	const handler = defaultExport.email;
	if (typeof handler !== "function") return undefined;
	return (message, environment, context) =>
		Reflect.apply(handler, defaultExport, [message, environment, context]);
}

// What `email()` receives. forward() and reply() send through the SMTP server in
// ORANGE_EMAIL_SMTP_URL, and fail without one: Wrangler's local route reports success and
// delivers nothing, but on Orange that would lose mail silently.
// https://developers.cloudflare.com/email-routing/email-workers/runtime-api/
export class ForwardableEmailMessage {
	readonly from: string;
	readonly to: string;
	readonly headers: Headers;
	readonly raw: ReadableStream<Uint8Array>;
	readonly rawSize: number;
	readonly #bytes: Uint8Array;
	readonly #sender: SmtpSender | undefined;
	#rejectReason: string | undefined;

	constructor(from: string, to: string, raw: Uint8Array, headers: Headers, sender?: SmtpSender) {
		this.from = from;
		this.to = to;
		this.headers = headers;
		this.rawSize = raw.byteLength;
		this.raw = new Response(raw).body as ReadableStream<Uint8Array>;
		this.#bytes = raw;
		this.#sender = sender;
	}

	setReject(reason: string): void {
		this.#rejectReason = String(reason);
	}

	get rejectReason(): string | undefined {
		return this.#rejectReason;
	}

	// The message goes to `rcptTo` as it arrived, from this address, as a relay sends it. Cloudflare
	// allows only `X-` headers to be added.
	async forward(rcptTo: string, headers?: Headers): Promise<EmailSendResult> {
		const sender = this.#configuredSender("forward");
		const added: string[] = [];
		for (const [name, value] of headers ?? []) {
			if (!/^x-/i.test(name)) throw new TypeError(`message.forward() may only add X- headers, not ${name}`);
			added.push(`${name}: ${value}`);
		}
		const raw =
			added.length === 0 ? this.#bytes : Buffer.concat([Buffer.from(`${added.join("\r\n")}\r\n`, "latin1"), this.#bytes]);
		await sender.send({ from: this.to, to: [String(rcptTo)] }, raw);
		return { messageId: messageIdOf(this.#bytes) };
	}

	async reply(message: unknown): Promise<EmailSendResult> {
		const sender = this.#configuredSender("reply");
		const parts = await emailMessageParts(message);
		if (parts === undefined) throw new TypeError("message.reply() takes an EmailMessage from cloudflare:email");
		await sender.send(parts.envelope, parts.raw);
		return { messageId: messageIdOf(parts.raw) };
	}

	#configuredSender(method: "forward" | "reply"): SmtpSender {
		if (this.#sender === undefined) {
			throw new Error(
				`message.${method}() needs ${smtpUrlSetting}. Set it to your SMTP server, such as smtp://user:password@smtp.example.com:587.`,
			);
		}
		return this.#sender;
	}
}

// Workers' production limit, which Wrangler's route also applies.
const maximumEmailBytes = 25 * 1024 * 1024;

// The header lines of a message and where its body starts. A continuation line starts with a space
// or tab and belongs to the header before it.
function splitHeaders(raw: Uint8Array): { lines: string[]; bodyStart: number } {
	const text = Buffer.from(raw).toString("latin1");
	const match = /\r?\n\r?\n/.exec(text);
	const end = match?.index ?? text.length;
	const lines: string[] = [];
	for (const line of text.slice(0, end).split(/\r?\n/)) {
		if (/^[ \t]/.test(line) && lines.length > 0) lines[lines.length - 1] += `\r\n${line}`;
		else lines.push(line);
	}
	return { bodyStart: match === null ? text.length : end + match[0].length, lines };
}

// SMTP removes Bcc before a recipient gets a message, so the handler never sees it.
function withoutBcc(raw: Uint8Array): { headers: Headers; messageId: string | null; raw: Uint8Array } {
	const { bodyStart, lines } = splitHeaders(raw);
	const kept = lines.filter((line) => !/^bcc[ \t]*:/i.test(line));
	const headers = new Headers();
	for (const line of kept) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		try {
			headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).replace(/\r\n[ \t]+/g, " ").trim());
		} catch {
			// A header name that Headers refuses stays in `raw`, the message itself.
		}
	}
	const delivered =
		kept.length === lines.length
			? raw
			: Buffer.concat([Buffer.from(`${kept.join("\r\n")}\r\n\r\n`, "latin1"), raw.subarray(bodyStart)]);
	return { headers, messageId: headers.get("message-id"), raw: delivered };
}

export interface EmailDispatchOptions {
	environment: object;
	exports: object;
	handler: EmailHandler | undefined;
}

// The route that a provider's inbound webhook, or anything that can POST a raw message, calls to
// run the Worker's `email()` handler. `orange serve` serves it only when this secret is set.
export const inboundSecretSetting = "ORANGE_EMAIL_INBOUND_SECRET";
export const inboundEmailPath = "/cdn-cgi/handler/email";

// The secret comes as `Authorization: Bearer <secret>`, or as the password of Basic auth, which a
// provider can put in the webhook URL as `https://user:<secret>@host/...`.
export function inboundEmailAuthorized(request: Request, secret: string): boolean {
	const authorization = request.headers.get("authorization") ?? "";
	let presented: string | undefined;
	const [scheme = "", value = ""] = authorization.split(/\s+/, 2);
	if (/^bearer$/i.test(scheme)) presented = value;
	else if (/^basic$/i.test(scheme)) {
		const decoded = Buffer.from(value, "base64").toString("utf8");
		presented = decoded.slice(decoded.indexOf(":") + 1);
	}
	if (presented === undefined) return false;
	const expected = Buffer.from(secret);
	const actual = Buffer.from(presented);
	return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

export function unauthorizedInboundEmail(): Response {
	return new Response(`Unauthorized: send ${inboundSecretSetting} as a Bearer token or as the Basic auth password.`, {
		headers: { "WWW-Authenticate": 'Basic realm="orange email"' },
		status: 401,
	});
}

// The envelope and message of a POST: a raw message with `?from=&to=`, as Wrangler's route takes,
// or form data with the raw message as SendGrid (`email`, `envelope`) or Mailgun (`body-mime`,
// `sender`, `recipient`) posts it.
async function incomingEmail(request: Request): Promise<{ from: string | null; raw: Uint8Array; to: string | null } | undefined> {
	const url = new URL(request.url);
	let from = url.searchParams.get("from");
	let to = url.searchParams.get("to");
	if (request.body === null) return undefined;
	if (!/^multipart\/form-data/i.test(request.headers.get("content-type") ?? "")) {
		return { from, raw: new Uint8Array(await request.arrayBuffer()), to };
	}
	const form = await request.formData();
	const mime = form.get("email") ?? form.get("body-mime");
	if (mime === null) return undefined;
	const envelope = form.get("envelope");
	if (typeof envelope === "string") {
		try {
			const parsed: unknown = JSON.parse(envelope);
			if (isRecord(parsed)) {
				from ??= typeof parsed.from === "string" ? parsed.from : null;
				to ??= Array.isArray(parsed.to) && typeof parsed.to[0] === "string" ? parsed.to[0] : null;
			}
		} catch {
			// A bad envelope leaves the addresses unset, which the caller reports.
		}
	}
	const sender = form.get("sender");
	const recipient = form.get("recipient");
	from ??= typeof sender === "string" ? sender : null;
	to ??= typeof recipient === "string" ? recipient : null;
	const raw = typeof mime === "string" ? Buffer.from(mime, "utf8") : new Uint8Array(await mime.arrayBuffer());
	return { from, raw, to };
}

/** `POST /cdn-cgi/handler/email`: the mail arrives as the request body. */
export async function dispatchEmailRequest(
	request: Request,
	options: EmailDispatchOptions,
): Promise<Response> {
	const email = await incomingEmail(request);
	const { from, to } = email ?? { from: null, to: null };
	if (email === undefined || !from || !to) {
		return new Response(
			"Invalid email. Your request must include URL parameters specifying the `from` and `to` addresses, as well as an email in the body",
			{ status: 400 },
		);
	}
	const incoming = email.raw;
	if (incoming.byteLength > maximumEmailBytes) {
		return new Response("Email message size is bigger than the production size limit of 25 MiB.", {
			status: 400,
		});
	}
	const { headers, messageId, raw } = withoutBcc(incoming);
	if (messageId === null) {
		return new Response("Email could not be parsed: invalid or no message id provided", {
			status: 400,
		});
	}
	const { handler } = options;
	if (handler === undefined) {
		return new Response("Worker does not export an email() handler.", { status: 500 });
	}
	const message = new ForwardableEmailMessage(from, to, raw, headers, smtpSenderFromSettings(runtimeSettings()));
	const execution = createExecutionContext({ exports: options.exports, props: undefined });
	try {
		await runInExecutionContext(execution.context, () =>
			handler(message, options.environment, execution.context),
		);
		await execution.drainWaitUntil();
	} catch (error: unknown) {
		await execution.drainWaitUntil();
		return new Response(error instanceof Error ? (error.stack ?? error.message) : String(error), {
			status: 500,
		});
	} finally {
		execution.end();
	}
	if (message.rejectReason !== undefined) {
		return new Response(`Worker rejected email with the following reason: ${message.rejectReason}`, {
			status: 400,
		});
	}
	return new Response("Worker successfully processed email");
}
