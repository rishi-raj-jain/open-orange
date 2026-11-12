import { getEventListeners } from "node:events";

import { isCapnWebRpcTarget } from "../bindings/durable-objects/rpc/capnweb.js";
import { DurableObjectRpcTarget } from "../bindings/durable-objects/rpc/target.js";
import { Event, type EventInit } from "./event.js";
import { dispatchEventCollectingErrors } from "./global-scope.js";
import { structuredClone } from "./native.js";
import { NodeEventTarget } from "./node-web.js";

type ListenerOptions = object | boolean;

// The init accepts MessagePort values from any declaration of the class, so
// its type is structural. The constructor checks the real brand at runtime.
export interface MessagePortLike {
	close(): void;
	postMessage(data?: unknown, options?: unknown): void;
	start(): void;
}

export interface MessageEventInit extends EventInit {
	data?: unknown;
	lastEventId?: string;
	origin?: string | null;
	ports?: readonly MessagePortLike[];
	source?: MessagePortLike | null;
}

interface MessageEventState {
	data: unknown;
	lastEventId: string;
	origin: string | null;
	ports: MessagePort[];
	source: MessagePort | null;
}

const messageEventStates = new WeakMap<object, MessageEventState>();

function messageEventState(event: object): MessageEventState {
	const state = messageEventStates.get(event);
	if (state === undefined) throw new TypeError("Illegal invocation");
	return state;
}

function messageEventPorts(ports: unknown): MessagePort[] {
	if (ports === undefined) return [];
	if (!Array.isArray(ports)) {
		throw new TypeError(
			"Incorrect type for the 'ports' field on 'Initializer': the provided value is not of type 'Array'.",
		);
	}
	return ports.map((port: unknown, index): MessagePort => {
		if (port instanceof MessagePort) return port;
		throw new TypeError(
			`Incorrect type for array element ${index}: the provided value is not of type 'MessagePort'.`,
		);
	});
}

function messageEventSource(source: unknown): MessagePort | null {
	if (source === undefined) return null;
	if (source instanceof MessagePort) return source;
	throw new TypeError(
		"Incorrect type for the 'source' field on 'Initializer': the provided value is not of type 'MessagePort'.",
	);
}

// workerd's MessageEvent takes its own MessagePort values in its init, unlike
// Node's, which only takes Node worker ports. Like workerd, ports must be an
// Array of MessagePort values and source must be a MessagePort.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/events.h#L20-L118
export class MessageEvent extends Event {
	constructor(type: string, init: MessageEventInit = {}) {
		super(type, init);
		messageEventStates.set(this, {
			data: init.data ?? null,
			lastEventId: init.lastEventId === undefined ? "" : String(init.lastEventId),
			origin: init.origin === undefined ? "" : init.origin,
			ports: messageEventPorts(init.ports),
			source: messageEventSource(init.source),
		});
	}

	get data(): unknown {
		return messageEventState(this).data;
	}

	get lastEventId(): string {
		return messageEventState(this).lastEventId;
	}

	get origin(): string | null {
		return messageEventState(this).origin;
	}

	get ports(): MessagePort[] {
		return messageEventState(this).ports;
	}

	get source(): MessagePort | null {
		return messageEventState(this).source;
	}
}

function trustedMessageEvent(type: string, data: unknown, source: MessagePort): MessageEvent {
	const event = new MessageEvent(type, { data, origin: null, source });
	Object.defineProperty(event, "isTrusted", { configurable: true, enumerable: true, value: true });
	return event;
}

type PortState = "closed" | "pending" | "started";

// Only MessageChannel constructs and entangles ports.
const entangleToken = Symbol("MessagePort");
const entangleSymbol = Symbol("MessagePort.entangle");

interface OnMessageEntry {
	handler: unknown;
	readonly listener: (event: Event) => void;
}

// An in-process MessagePort, like workerd's: delivery is deferred to a
// microtask, messages queue until the port has a message listener, and a
// throwing listener also produces a "messageerror" event.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/messagechannel.c%2B%2B#L10-L231
export class MessagePort extends NodeEventTarget {
	#onmessage: OnMessageEntry | undefined;
	#other: MessagePort | undefined;
	readonly #queue: unknown[] = [];
	#state: PortState = "pending";

	constructor(token?: typeof entangleToken) {
		super();
		if (token !== entangleToken) throw new TypeError("Illegal constructor");
	}

	static [entangleSymbol](port1: MessagePort, port2: MessagePort): void {
		port1.#other = port2;
		port2.#other = port1;
	}

	get onmessage(): unknown {
		return this.#onmessage?.handler ?? null;
	}

	// The handler keeps the position of its first assignment. Clearing it
	// removes that position, and a non-callable object still starts the port.
	set onmessage(handler: unknown) {
		if (this.#state === "closed") {
			this.#onmessage = undefined;
			return;
		}
		if ((typeof handler !== "object" || handler === null) && typeof handler !== "function") {
			if (this.#onmessage !== undefined) {
				super.removeEventListener("message", this.#onmessage.listener);
				this.#onmessage = undefined;
			}
			return;
		}
		if (this.#onmessage !== undefined) {
			this.#onmessage.handler = handler;
			return;
		}
		const entry: OnMessageEntry = {
			handler,
			listener: (event: Event): void => {
				const current = entry.handler;
				if (typeof current === "function") Reflect.apply(current, this, [event]);
			},
		};
		this.#onmessage = entry;
		super.addEventListener("message", entry.listener);
		this.#start();
	}

	override addEventListener(type: string, listener: unknown, options?: ListenerOptions): void {
		super.addEventListener(type, listener, options);
		if (type === "message") this.#start();
	}

	postMessage(data?: unknown, options?: unknown[] | { transfer?: unknown[] }): void {
		const transfer = Array.isArray(options) ? options : options?.transfer;
		if (transfer !== undefined && transfer.length > 0) {
			throw new Error("Transfer list is not supported");
		}
		if (
			typeof data === "object" &&
			data !== null &&
			(data instanceof DurableObjectRpcTarget || isCapnWebRpcTarget(data))
		) {
			throw new DOMException(
				"Could not serialize object of type \"RpcTarget\". This type does not support serialization.",
				"DataCloneError",
			);
		}
		const cloned = structuredClone(data);
		const other = this.#other;
		if (other !== undefined) other.#deliver(cloned);
	}

	start(): void {
		this.#start();
	}

	close(): void {
		if (this.#state === "closed") return;
		this.#state = "closed";
		this.#queue.length = 0;
		const other = this.#other;
		this.#other = undefined;
		other?.close();
		const event = new Event("close");
		Object.defineProperty(event, "isTrusted", { configurable: true, enumerable: true, value: true });
		this.dispatchEvent(event);
	}

	#hasMessageListeners(): boolean {
		return getEventListeners(this, "message").length > 0;
	}

	#deliver(data: unknown): void {
		if (this.#state === "closed") return;
		if (this.#state === "started" && !this.#hasMessageListeners()) this.#state = "pending";
		if (this.#state === "pending") {
			this.#queue.push(data);
			return;
		}
		queueMicrotask(() => this.#dispatchMessage(data));
	}

	#start(): void {
		if (this.#state !== "pending") return;
		this.#state = "started";
		const queued = this.#queue.splice(0);
		if (queued.length === 0) return;
		queueMicrotask(() => {
			for (const data of queued) this.#dispatchMessage(data);
		});
	}

	#dispatchMessage(data: unknown): void {
		if (this.#state === "closed") return;
		const errors = dispatchEventCollectingErrors(
			this,
			trustedMessageEvent("message", data, this),
		);
		if (errors.threw) {
			dispatchEventCollectingErrors(
				this,
				trustedMessageEvent("messageerror", errors.error, this),
			);
		}
	}
}

export class MessageChannel {
	readonly port1: MessagePort;
	readonly port2: MessagePort;

	constructor() {
		this.port1 = new MessagePort(entangleToken);
		this.port2 = new MessagePort(entangleToken);
		MessagePort[entangleSymbol](this.port1, this.port2);
	}
}
