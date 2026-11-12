// The cloudflare:email module. A message keeps its raw MIME for a Send Email binding or
// `message.reply()`. The runtime and the Worker bundle load separate copies of this module, so
// the raw message is kept under a global symbol that both copies read.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/email.d.ts#L7-L11

const rawKey = Symbol.for("open-orange.email-message.raw");

export class EmailMessage {
	readonly from: string;
	readonly to: string;
	declare readonly [rawKey]: ReadableStream | string;

	constructor(from: string, to: string, raw: ReadableStream | string) {
		this.from = String(from);
		this.to = String(to);
		Object.defineProperty(this, rawKey, { value: raw });
	}
}

export default { EmailMessage };
