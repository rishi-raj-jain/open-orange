import { clearTimeout, setTimeout } from "node:timers";

import type {
	WebSocket,
	WebSocketIncomingHandlers,
} from "../../globals/websocket.js";
import type { DurableObjectGeneration } from "./state.js";

type HibernatableWebSocketMethod =
	| "webSocketClose"
	| "webSocketError"
	| "webSocketMessage";

function invokeOptionalMethod(
	generation: DurableObjectGeneration,
	name: HibernatableWebSocketMethod,
	parameters: unknown[],
): Promise<void> | undefined {
	const method: unknown = Reflect.get(generation.instance, name);
	if (typeof method !== "function") return;
	return generation.stateController.runEvent(async () => {
		await Reflect.apply(method, generation.instance, parameters);
	});
}

export interface HibernatableWebSocketIncomingHandlerOptions {
	onEventSettled?: () => void;
	onEventTimeout?: () => void;
}

function applyEventTimeout(
	generation: DurableObjectGeneration,
	result: void | Promise<void>,
	onEventTimeout: (() => void) | undefined,
): void | Promise<void> {
	// Workerd races each hibernatable event promise against an actor shutdown.
	// Orange can request Rivet sleep after this timer fires, but a synchronous
	// handler that blocks the shared Node thread cannot let the timer run until
	// worker-thread isolation lands.
	// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/global-scope.c%2B%2B#L757-L782
	const timeoutMilliseconds =
		generation.hibernatableWebSockets.getEventTimeout();
	if (result === undefined || timeoutMilliseconds === null) return result;
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			onEventTimeout?.();
			reject(
				new Error(
					"Actor exceeded event execution time and was disconnected.",
				),
			);
		}, timeoutMilliseconds);
		result.then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

// Workerd drops a socket only after its terminal event settles, even when the
// handler fails, so the handler still sees the socket in getWebSockets().
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/legacy-hibernation-manager.c%2B%2B#L465-L474
function releaseAfterEvent(
	generation: DurableObjectGeneration,
	socket: WebSocket,
	dispatch: () => void | Promise<void>,
): void | Promise<void> {
	const store = generation.hibernatableWebSockets;
	store.endConnection(socket);
	let result: void | Promise<void>;
	try {
		result = dispatch();
	} catch (error) {
		store.releaseWebSocket(socket);
		throw error;
	}
	if (result === undefined) {
		store.releaseWebSocket(socket);
		return;
	}
	return result.finally(() => store.releaseWebSocket(socket));
}

function settleEvent(
	generation: DurableObjectGeneration,
	result: void | Promise<void>,
	options: HibernatableWebSocketIncomingHandlerOptions,
): void | Promise<void> {
	if (result === undefined) {
		options.onEventSettled?.();
		return;
	}
	let timedOut = false;
	const timed = applyEventTimeout(generation, result, () => {
		timedOut = true;
		options.onEventTimeout?.();
	});
	if (timed === undefined) {
		options.onEventSettled?.();
		return;
	}
	return timed.then(
		() => {
			if (!timedOut) options.onEventSettled?.();
		},
		(error: unknown) => {
			if (!timedOut) options.onEventSettled?.();
			throw error;
		},
	);
}

// Hibernatable frames bypass the ordinary WebSocket event loop and call the
// exported Durable Object methods directly. Workerd claims a freshly restored
// wrapper for each event and silently consumes events whose optional method is
// absent:
// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/global-scope.c%2B%2B#L782-L879
//
// Rivet persists and acknowledges the native transport message index after
// dispatch. Orange deliberately has no JavaScript replay queue: a wake receives
// only the frames after Rivet's persisted serverMessageIndex, while returning a
// handler promise lets Rivet keep the actor's WebSocket callback region alive:
// https://github.com/rivet-dev/actors/blob/3848076c011ad2f881bca9821e4d5c725aa9f15e/rivetkit-rust/packages/rivetkit-core/src/registry/websocket.rs#L586-L625
// https://github.com/rivet-dev/actors/blob/3848076c011ad2f881bca9821e4d5c725aa9f15e/rivetkit-typescript/packages/rivetkit/src/registry/native.ts#L2408-L2432
export function createHibernatableWebSocketIncomingHandlers(
	generation: DurableObjectGeneration,
	socket: WebSocket,
	options: HibernatableWebSocketIncomingHandlerOptions = {},
): WebSocketIncomingHandlers {
	let terminal = false;
	return {
		close(code, reason, wasClean): void | Promise<void> {
			if (terminal) return;
			terminal = true;
			return releaseAfterEvent(generation, socket, () =>
				settleEvent(
					generation,
					invokeOptionalMethod(generation, "webSocketClose", [
						socket,
						code,
						reason,
						wasClean,
					]),
					options,
				),
			);
		},
		error(error): void | Promise<void> {
			if (terminal) return;
			terminal = true;
			return releaseAfterEvent(generation, socket, () =>
				settleEvent(
					generation,
					invokeOptionalMethod(generation, "webSocketError", [
						socket,
						error,
					]),
					options,
				),
			);
		},
		message(message): void | Promise<void> {
			if (terminal) return;
			return settleEvent(
				generation,
				invokeOptionalMethod(generation, "webSocketMessage", [
					socket,
					message,
				]),
				options,
			);
		},
	};
}
