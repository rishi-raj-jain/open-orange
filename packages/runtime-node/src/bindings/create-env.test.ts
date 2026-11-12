import assert from "node:assert/strict";
import test from "node:test";

import { createEnvironment } from "./create-env.js";

test("constructs an extensible Worker environment from binding values", () => {
	const secret = { get: async () => "value" };
	const environment = createEnvironment([
		{ name: "MESSAGE", value: "hello" },
		{ name: "SECRET", value: secret },
		{ name: "__proto__", value: "safe own property" },
	]);

	assert.deepEqual(Object.keys(environment), ["MESSAGE", "SECRET", "__proto__"]);
	assert.equal(environment.MESSAGE, "hello");
	assert.equal(environment.SECRET, secret);
	assert.equal(environment.__proto__, "safe own property");
	environment.ADDED = true;
	assert.equal(environment.ADDED, true);
});

test("rejects empty and duplicate binding names", () => {
	assert.throws(
		() => createEnvironment([{ name: "", value: "value" }]),
		/cannot be empty/,
	);
	assert.throws(
		() =>
			createEnvironment([
				{ name: "DUPLICATE", value: 1 },
				{ name: "DUPLICATE", value: 2 },
			]),
		/Duplicate Worker environment binding "DUPLICATE"/,
	);
});
