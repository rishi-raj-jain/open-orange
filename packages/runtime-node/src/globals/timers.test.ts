import assert from "node:assert/strict";
import test from "node:test";

import {
	clearInterval,
	clearTimeout,
	setInterval,
	setTimeout,
} from "./timers.js";

test("passes callback arguments and cancels by Timeout or numeric identifier", async () => {
	const result = Promise.withResolvers<string>();
	setTimeout((value: string) => result.resolve(value), 0, "fired");
	assert.equal(await result.promise, "fired");

	let calls = 0;
	const byObject = setTimeout(() => (calls += 1), 1);
	const byNumber = setTimeout(() => (calls += 1), 1);
	clearTimeout(byObject);
	clearTimeout(+byNumber);
	await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 10));
	assert.equal(calls, 0);
});

test("cancels timeouts and intervals through one identifier pool", async () => {
	let calls = 0;
	const timeout = setTimeout(() => {
		calls += 1;
	}, 1);
	clearInterval(timeout);
	const interval = setInterval(() => {
		calls += 1;
	}, 1);
	clearTimeout(interval);
	await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 10));
	assert.equal(calls, 0);
});
