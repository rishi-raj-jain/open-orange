import { randomUUID } from "node:crypto";

// Node.js's own timers: the expiry of an unclaimed upgrade is not a timer of the object.
import { clearTimeout, setTimeout } from "node:timers";
import { Response } from "../../globals/http.js";
import {
	terminateCoupledWebSocket,
	type WebSocket,
} from "../../globals/websocket.js";

const upgradeLifetimeMilliseconds = 30_000;

interface RetainedUpgrade {
	response: Response;
	timer: ReturnType<typeof setTimeout>;
}

export interface DurableObjectWebSocketUpgradeDescriptor {
	headers: [string, string][];
	statusText: string;
	token: string;
}

function closeUnclaimedSocket(socket: WebSocket): void {
	try {
		socket.accept({ allowHalfOpen: true });
		socket.close(1012, "Durable Object WebSocket upgrade expired");
	} catch {
		// The socket may already have been released by a failed actor generation.
	}
}

export class DurableObjectWebSocketUpgradeStore {
	readonly #active = new Map<string, WebSocket>();
	readonly #upgrades = new Map<string, RetainedUpgrade>();
	#disposed = false;

	retain(response: Response): DurableObjectWebSocketUpgradeDescriptor {
		if (this.#disposed) {
			throw new Error("Durable Object WebSocket upgrade store is disposed");
		}
		if (response.status !== 101 || response.webSocket === null) {
			throw new TypeError(
				"Durable Object WebSocket fetch must return a status 101 Response with a WebSocket",
			);
		}
		const token = randomUUID();
		const timer = setTimeout(() => {
			const retained = this.#upgrades.get(token);
			if (retained === undefined) return;
			this.#upgrades.delete(token);
			const socket = retained.response.webSocket;
			if (socket !== null) closeUnclaimedSocket(socket);
		}, upgradeLifetimeMilliseconds);
		this.#upgrades.set(token, { response, timer });
		return {
			headers: [...response.headers],
			statusText: response.statusText,
			token,
		};
	}

	claim(token: string): WebSocket {
		const retained = this.#upgrades.get(token);
		if (retained === undefined) {
			throw new Error("Durable Object WebSocket upgrade token is invalid or expired");
		}
		this.#upgrades.delete(token);
		clearTimeout(retained.timer);
		const socket = retained.response.webSocket;
		if (socket === null) {
			throw new Error("Retained Durable Object upgrade lost its WebSocket");
		}
		this.#active.set(token, socket);
		socket.addEventListener("close", () => this.#active.delete(token), {
			once: true,
		});
		return socket;
	}

	/** The upgrades that wait for their clients to claim them. */
	get unclaimedUpgrades(): number {
		return this.#upgrades.size;
	}

	dispose(preserve?: (socket: WebSocket) => boolean): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const retained of this.#upgrades.values()) {
			clearTimeout(retained.timer);
			if (retained.response.webSocket !== null) {
				closeUnclaimedSocket(retained.response.webSocket);
			}
		}
		this.#upgrades.clear();
		for (const socket of this.#active.values()) {
			if (preserve?.(socket) === true) continue;
			terminateCoupledWebSocket(
				socket,
				1012,
				"Durable Object generation ended",
				false,
			);
		}
		this.#active.clear();
	}
}
