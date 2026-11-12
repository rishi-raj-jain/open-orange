import { currentExecutionContext } from "../context.js";
import { currentDurableObjectOutputGate } from "../internal/output-gate.js";
import { Event } from "./event.js";
import {
	defineEventHandlerAttribute,
	dispatchEventCollectingErrors,
	ErrorEvent,
} from "./global-scope.js";
import { fetch, Headers, Response } from "./http.js";
import { MessageEvent } from "./messagechannel.js";
import { AbortController, ReadableStream } from "./native.js";
import { NodeEventTarget } from "./node-web.js";

interface Fetcher {
	fetch(input: string, init: object): Promise<InstanceType<typeof globalThis.Response>>;
}

export interface EventSourceInit {
	fetcher?: Fetcher;
	withCredentials?: boolean;
}

interface PendingMessage {
	data: string[];
	event?: string;
	id: string;
}

// EventSource.from() passes this token to build an instance without a URL.
const fromStream = Symbol("EventSource.from");

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/eventsource.h#L186-L191
const DEFAULT_RECONNECTION_TIME = 2_000;
const MIN_RECONNECTION_TIME = 1_000;
const MAX_RECONNECTION_TIME = 10_000;

// A Worker request or a Durable Object event has an IoContext in workerd. Only module scope does
// not.
function requireRequestContext(): void {
	if (
		currentExecutionContext() === undefined &&
		currentDurableObjectOutputGate() === undefined
	) {
		throw new DOMException(
			"An EventSource can only be created within the context of a worker request.",
			"NotSupportedError",
		);
	}
}

function isEventStream(contentType: string): boolean {
	const essence = contentType.split(";", 1)[0]?.trim().toLowerCase();
	return essence === "text/event-stream";
}

// Mirrors workerd's EventSource: a fetch-driven event-stream parser with
// reconnection, plus EventSource.from() for an existing stream.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/eventsource.c%2B%2B#L17-L559
export class EventSource extends NodeEventTarget {
	static readonly CONNECTING = CONNECTING;
	static readonly OPEN = OPEN;
	static readonly CLOSED = CLOSED;

	#abortController = new AbortController();
	#closeCalled = false;
	readonly #fetcher: Fetcher | undefined;
	#lastEventId = "";
	#previousNoBody = false;
	#readyState = CONNECTING;
	#reconnectionTime = DEFAULT_RECONNECTION_TIME;
	#url: URL | undefined;

	constructor(url: string, init?: EventSourceInit, source?: typeof fromStream) {
		super();
		requireRequestContext();
		if (source === fromStream) {
			this.#fetcher = undefined;
			return;
		}
		if (init?.withCredentials === true) {
			throw new DOMException(
				"The init.withCredentials option is not supported. It must be false or undefined.",
				"NotSupportedError",
			);
		}
		const parsed = URL.parse(String(url));
		if (parsed === null) {
			throw new DOMException(
				`Cannot open an EventSource to '${String(url)}'. The URL is invalid.`,
				"SyntaxError",
			);
		}
		this.#url = parsed;
		this.#fetcher = init?.fetcher;
		this.#start();
	}

	static from(readable: ReadableStream<Uint8Array>): EventSource {
		requireRequestContext();
		if (readable.locked) throw new TypeError("This ReadableStream is locked.");
		const eventSource = new EventSource("", undefined, fromStream);
		eventSource.#run(readable, false);
		return eventSource;
	}

	get url(): string {
		return this.#url?.href ?? "";
	}

	get withCredentials(): boolean {
		return false;
	}

	get readyState(): number {
		return this.#readyState;
	}

	declare onerror: unknown;
	declare onmessage: unknown;
	declare onopen: unknown;

	close(): void {
		if (this.#closeCalled) return;
		this.#closeCalled = true;
		this.#abortController.abort();
		this.#readyState = CLOSED;
	}

	[Symbol.dispose](): void {
		this.close();
	}

	#notifyError(error: unknown, reconnecting = false): void {
		if (this.#readyState === CLOSED) return;
		this.#abortController.abort(error);
		this.#readyState = reconnecting ? CONNECTING : CLOSED;
		const event = new ErrorEvent("error", { error });
		dispatchEventCollectingErrors(this, event);
	}

	#notifyOpen(): void {
		if (this.#readyState === CLOSED) return;
		this.#readyState = OPEN;
		const errors = dispatchEventCollectingErrors(this, new Event("open"));
		if (errors.threw) this.#notifyError(errors.error);
	}

	#notifyMessages(messages: PendingMessage[]): void {
		for (const message of messages) {
			if (this.#readyState === CLOSED) return;
			const data = message.data.join("\n");
			if (data.length === 0) continue;
			const event = new MessageEvent(message.event ?? "message", {
				data,
				lastEventId: message.id,
				origin: this.#url?.origin ?? "",
			});
			const errors = dispatchEventCollectingErrors(this, event);
			if (errors.threw) {
				this.#notifyError(errors.error);
				return;
			}
		}
	}

	#reconnect(): void {
		this.#readyState = CONNECTING;
		this.#abortController = new AbortController();
		const signal = this.#abortController.signal;
		const timer = setTimeout(() => this.#start(), this.#reconnectionTime);
		signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
	}

	#start(): void {
		const url = this.#url;
		if (url === undefined || this.#readyState === CLOSED) return;
		const headers = new Headers({
			accept: "text/event-stream",
			"cache-control": "no-cache",
		});
		if (this.#lastEventId !== "") headers.set("last-event-id", this.#lastEventId);
		const init = { headers, signal: this.#abortController.signal };
		const request =
			this.#fetcher === undefined
				? fetch(url.href, init)
				: this.#fetcher.fetch(url.href, init);
		request.then(
			(response) => {
				if (this.#readyState === CLOSED) return;
				const abortError = (message: string): void =>
					this.#notifyError(new DOMException(message, "AbortError"));
				if (!response.ok) {
					abortError(`The response status code was ${response.status}.`);
					return;
				}
				const contentType = response.headers.get("content-type");
				if (contentType === null) {
					abortError("No content type header was present in the response.");
					return;
				}
				if (!isEventStream(contentType)) {
					abortError(`The content type '${contentType}' is invalid.`);
					return;
				}
				if (response.redirected && response.url !== "") {
					this.#url = new URL(response.url);
				}
				if (response.body === null) {
					if (this.#previousNoBody) {
						this.#notifyError(new Error("The server provided no content."));
					} else {
						this.#previousNoBody = true;
						this.#notifyError(
							new Error("The server provided no content. Will try reconnecting."),
							true,
						);
						this.#reconnect();
					}
					return;
				}
				this.#run(response.body, true);
			},
			(error: unknown) => this.#notifyError(error),
		);
	}

	#run(readable: ReadableStream<Uint8Array>, withReconnection: boolean): void {
		this.#notifyOpen();
		void this.#pump(readable).then(
			() => {
				this.#notifyError(new Error("The server disconnected."), withReconnection);
				if (withReconnection && this.#readyState !== CLOSED) this.#reconnect();
			},
			(error: unknown) => this.#notifyError(error),
		);
	}

	// Parses the event stream line by line, as workerd's EventSourceSink does.
	async #pump(readable: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder("utf-8", { ignoreBOM: false });
		const reader = readable.getReader();
		const signal = this.#abortController.signal;
		const onAbort = (): void => void reader.cancel(signal.reason).catch(() => undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		let kept = "";
		let current: PendingMessage | undefined;
		const feed = (line: string, pending: PendingMessage[]): void => {
			if (line.length === 0) {
				if (current !== undefined) {
					current.id = this.#lastEventId;
					pending.push(current);
					current = undefined;
				}
				return;
			}
			if (line.startsWith(":")) return;
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			current ??= { data: [], id: "" };
			if (field === "data") current.data.push(value);
			else if (field === "event") current.event = value;
			else if (field === "id") this.#lastEventId = value;
			else if (field === "retry" && /^\d+$/.test(value)) {
				this.#reconnectionTime = Math.max(
					Math.min(Number(value), MAX_RECONNECTION_TIME),
					MIN_RECONNECTION_TIME,
				);
			}
		};
		try {
			for (;;) {
				const result = await reader.read();
				if (result.done || this.#readyState === CLOSED) return;
				let input = kept + decoder.decode(result.value, { stream: true });
				kept = "";
				const pending: PendingMessage[] = [];
				for (;;) {
					const match = /\r\n|\r|\n/.exec(input);
					if (match === null) break;
					// A trailing CR may be the first half of CRLF.
					if (match[0] === "\r" && match.index === input.length - 1) break;
					feed(input.slice(0, match.index), pending);
					input = input.slice(match.index + match[0].length);
				}
				kept = input;
				if (pending.length !== 0) {
					await null;
					this.#notifyMessages(pending);
				}
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

for (const [name, value] of [
	["CONNECTING", CONNECTING],
	["OPEN", OPEN],
	["CLOSED", CLOSED],
] as const) {
	Object.defineProperty(EventSource.prototype, name, { enumerable: true, value });
}

for (const type of ["error", "message", "open"]) {
	defineEventHandlerAttribute(EventSource.prototype, type);
}
