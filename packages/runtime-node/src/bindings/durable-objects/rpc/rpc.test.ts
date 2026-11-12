import assert from "node:assert/strict";
import test from "node:test";

import { DurableObject } from "../../../modules/cloudflare-workers/durable-object.js";
import type { RivetWebSocket } from "../../../internal/rivetkit.js";
import {
	dispatchDurableObjectPrivateRequest,
	dispatchDurableObjectPrivateWebSocket,
	durableObjectPrivateRoutes,
	type DurableObjectRouteHandlers,
} from "../registry.js";
import { createDurableObjectGeneration } from "../state.js";
import { openCapnWebHttpBatchSession } from "./capnweb.js";
import { handleDurableObjectRpcHttp } from "./http.js";
import { DurableObjectRpcTarget } from "./target.js";
import {
	attachDurableObjectRpcWebSocket,
	type DurableObjectRpcWebSocketSession,
} from "./websocket.js";

class FixtureObject extends DurableObject {}

class EchoTarget extends DurableObjectRpcTarget {
	calls = 0;

	echo(value: string): string {
		this.calls += 1;
		return `echo:${value}`;
	}
}

const generation = createDurableObjectGeneration({
	bindings: {},
	className: "FixtureObject",
	userClass: FixtureObject,
});

type WebSocketListener = (event: unknown) => void | Promise<void>;

class TestWebSocket implements RivetWebSocket {
	binaryType: "arraybuffer" | "blob" = "blob";
	readonly closes: { code?: number; reason?: string }[] = [];
	readonly readyState = 1;
	readonly sends: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = [];
	readonly listeners = new Map<string, Set<WebSocketListener>>();

	addEventListener(type: string, listener: WebSocketListener): void {
		let listeners = this.listeners.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	close(code?: number, reason?: string): void {
		this.closes.push({ code, reason });
	}

	removeEventListener(type: string, listener: WebSocketListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		this.sends.push(data);
	}
}

test("runs a Cap'n Web HTTP batch behind the private Rivet route", async () => {
	const target = new EchoTarget();
	const routes: DurableObjectRouteHandlers = {
		fetch: () => new Response("not used", { status: 501 }),
		rpc: (_generation, request) =>
			handleDurableObjectRpcHttp(request, target),
		rpcWebSocket: () => undefined,
		webSocket: () => undefined,
	};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init): Promise<Response> => {
		return dispatchDurableObjectPrivateRequest(
			generation,
			new Request(input, init),
			routes,
		);
	};
	const client = openCapnWebHttpBatchSession(
		`http://actor${durableObjectPrivateRoutes.rpc}`,
	);
	try {
		assert.equal(await client.echo("hello"), "echo:hello");
		assert.equal(target.calls, 1);
	} finally {
		client[Symbol.dispose]();
		globalThis.fetch = originalFetch;
	}
});

test("attaches Cap'n Web to a runtime-owned private Rivet WebSocket", async () => {
	const target = new EchoTarget();
	const socket = new TestWebSocket();
	let session: DurableObjectRpcWebSocketSession | undefined;
	const routes: DurableObjectRouteHandlers = {
		fetch: () => new Response("not used", { status: 501 }),
		rpc: () => new Response("not used", { status: 501 }),
		rpcWebSocket: (_generation, _request, webSocket) => {
			session = attachDurableObjectRpcWebSocket(webSocket, target);
		},
		webSocket: () => undefined,
	};

	await dispatchDurableObjectPrivateWebSocket(
		generation,
		new Request(`http://actor${durableObjectPrivateRoutes.rpc}`),
		socket,
		routes,
	);

	assert.ok(session);
	assert.equal(socket.binaryType, "arraybuffer");
	assert.equal(socket.listeners.get("message")?.size, 1);
	assert.equal(socket.listeners.get("close")?.size, 1);
	assert.equal(socket.listeners.get("error")?.size, 1);
	assert.deepEqual(socket.closes, []);
	session.dispose();
});
