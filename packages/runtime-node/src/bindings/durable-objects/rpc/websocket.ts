import type { RivetWebSocket } from "../../../internal/rivetkit.js";
import { invokeCapnWebWebSocketSession, sendCapnWebAbort } from "./capnweb.js";
import type { DurableObjectRpcSessionTarget } from "./session.js";
import type { DurableObjectRpcTarget } from "./target.js";

export interface DurableObjectRpcWebSocketSession {
	dispose(): void;
}

export interface DurableObjectRpcAttachedSession {
	dispose(): Promise<void>;
}

export function attachDurableObjectRpcWebSocket(
	webSocket: RivetWebSocket,
	target: DurableObjectRpcTarget,
): DurableObjectRpcWebSocketSession {
	const remoteMain = invokeCapnWebWebSocketSession(webSocket, target);
	let disposed = false;
	return {
		dispose(): void {
			if (!disposed) {
				disposed = true;
				remoteMain[Symbol.dispose]();
			}
		},
	};
}

export async function attachDurableObjectRpcSessionWebSocket(
	webSocket: RivetWebSocket,
	target: DurableObjectRpcSessionTarget,
	// When the generation that serves the session resets, calls on the
	// session fail with the reset error, as workerd fails calls into an
	// aborted context.
	resetSignal?: AbortSignal,
): Promise<DurableObjectRpcAttachedSession> {
	let session: DurableObjectRpcWebSocketSession;
	try {
		session = attachDurableObjectRpcWebSocket(webSocket, target);
	} catch (error) {
		await target.releaseUnclaimed();
		throw error;
	}
	let disposed = false;
	const release = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		resetSignal?.removeEventListener("abort", abortOnReset);
		webSocket.removeEventListener("close", release);
		webSocket.removeEventListener("error", release);
		try {
			session.dispose();
		} finally {
			await target.releaseUnclaimed();
		}
	};
	const abortOnReset = (): void => {
		if (disposed || resetSignal === undefined) return;
		try {
			sendCapnWebAbort(webSocket, resetSignal.reason);
		} catch {
			// The socket is already closing, so the peer sees a disconnect instead.
		}
		void release();
	};
	webSocket.addEventListener("close", release);
	webSocket.addEventListener("error", release);
	if (resetSignal?.aborted) abortOnReset();
	else resetSignal?.addEventListener("abort", abortOnReset, { once: true });
	return { dispose: release };
}

// Rivet owns and supplies the already-open socket. Cap'n Web only attaches its
// protocol listeners; the surrounding runtime decides when to dispose it.
// https://github.com/cloudflare/capnweb/blob/7702075d4122e6808512ee50acc591310b77da7a/src/websocket.ts#L13-L22
