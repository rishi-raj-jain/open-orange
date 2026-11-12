import type { RivetWebSocket } from "../../../internal/rivetkit.js";

type WebSocketListener = (event: unknown) => void | Promise<void>;

export class LinkedTestWebSocket implements RivetWebSocket {
	binaryType: "arraybuffer" | "blob" = "blob";
	readonly #listeners = new Map<string, Set<WebSocketListener>>();
	readonly #pending = new Set<Promise<void>>();
	#peer: LinkedTestWebSocket | undefined;
	readyState: 0 | 1 | 2 | 3 = 1;

	connect(peer: LinkedTestWebSocket): void {
		this.#peer = peer;
	}

	addEventListener(type: string, listener: WebSocketListener): void {
		let listeners = this.#listeners.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			this.#listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	close(code?: number, reason?: string): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.emit("close", { code, reason });
		const peer = this.#peer;
		if (peer !== undefined && peer.readyState !== 3) {
			peer.readyState = 3;
			peer.emit("close", { code, reason });
		}
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.#listeners.get(type) ?? []) {
			const pending = Promise.resolve(listener(event)).then(() => undefined);
			this.#pending.add(pending);
			pending.finally(() => this.#pending.delete(pending)).catch(() => undefined);
		}
	}

	async flush(): Promise<void> {
		await new Promise<void>((resolve) => setImmediate(resolve));
		await Promise.all([...this.#pending]);
	}

	removeEventListener(type: string, listener: WebSocketListener): void {
		this.#listeners.get(type)?.delete(listener);
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (this.readyState !== 1 || this.#peer === undefined) {
			throw new Error("Linked WebSocket is not open");
		}
		const peer = this.#peer;
		queueMicrotask(() => peer.emit("message", { data }));
	}
}

export function createLinkedTestWebSocketPair(): readonly [
	LinkedTestWebSocket,
	LinkedTestWebSocket,
] {
	const client = new LinkedTestWebSocket();
	const server = new LinkedTestWebSocket();
	client.connect(server);
	server.connect(client);
	return [client, server];
}
