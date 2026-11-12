import assert from "node:assert/strict";
import test from "node:test";

import { assertSupportedNodeVersion } from "./runtime.js";

test("accepts Node.js 22 and later and rejects older majors", () => {
	assert.doesNotThrow(() => assertSupportedNodeVersion("22.0.0"));
	assert.doesNotThrow(() => assertSupportedNodeVersion("24.18.0"));
	assert.doesNotThrow(() => assertSupportedNodeVersion("25.0.0"));
	assert.throws(
		() => assertSupportedNodeVersion("20.19.0"),
		/requires Node\.js 22 or later; received 20\.19\.0/,
	);
});
