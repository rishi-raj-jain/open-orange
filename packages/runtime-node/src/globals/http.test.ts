import assert from "node:assert/strict";
import test from "node:test";

import { Request, Response } from "./http.js";
import { WebSocketPair } from "./websocket.js";

test("constructs Cloudflare requests from streaming bodies without a duplex option", async () => {
	const encoder = new TextEncoder();
	const request = new Request("https://worker.example/stream", {
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("streamed "));
				controller.enqueue(encoder.encode("body"));
				controller.close();
			},
		}),
		method: "POST",
	});

	assert.equal(request.method, "POST");
	assert.equal(await request.text(), "streamed body");
});

test("constructs status 101 WebSocket responses outside Undici's status range", () => {
	const pair = new WebSocketPair();
	const response = new Response(null, {
		headers: { "Sec-WebSocket-Protocol": "orange" },
		status: 101,
		webSocket: pair[0],
	});

	assert.equal(response.status, 101);
	assert.equal(response.statusText, "Switching Protocols");
	assert.equal(response.ok, false);
	assert.equal(response.body, null);
	assert.equal(response.webSocket, pair[0]);
	assert.equal(response.headers.get("sec-websocket-protocol"), "orange");
	assert.throws(
		() => response.clone(),
		/Cannot clone a response to a WebSocket handshake/,
	);
	assert.throws(
		() => new Response("body", { status: 101, webSocket: pair[1] }),
		/Response with null body status/,
	);
	assert.throws(
		() => new Response(null, { status: 200, webSocket: pair[1] }),
		/Responses with a WebSocket must have status code 101/,
	);
});
