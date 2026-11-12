import assert from "node:assert/strict";
import test from "node:test";

import {
	UndiciHeaders,
	UndiciRequest,
	UndiciResponse,
} from "./substrate.js";

test("uses the pinned Undici Fetch substrate", async () => {
	const headers = new UndiciHeaders({ "x-open-orange": "runtime-node" });
	const request = new UndiciRequest("https://example.com/", { headers });
	const response = new UndiciResponse("ready", { status: 202 });

	assert.equal(request.headers.get("x-open-orange"), "runtime-node");
	assert.equal(response.status, 202);
	assert.equal(await response.text(), "ready");
});
