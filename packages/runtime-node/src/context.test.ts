import assert from "node:assert/strict";
import test from "node:test";

import { createExecutionContext } from "./context.js";

test("exposes props and exports and drains waitUntil work", async () => {
	const exports = { SELF: "loopback" };
	const controller = createExecutionContext({
		exports,
		props: { requestId: "request-1" },
	});
	let completed = false;
	controller.context.waitUntil(
		Promise.resolve().then(() => {
			completed = true;
			return "done";
		}),
	);
	controller.context.waitUntil(Promise.reject(new Error("background failure")));

	const outcomes = await controller.drainWaitUntil();
	assert.equal(completed, true);
	assert.equal(controller.context.exports, exports);
	assert.deepEqual(controller.context.props, { requestId: "request-1" });
	assert.deepEqual(
		outcomes.map((outcome) => outcome.status),
		["fulfilled", "rejected"],
	);
});
