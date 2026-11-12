import assert from "node:assert/strict";
import test from "node:test";

import { atob, btoa } from "./base64.js";
import { TextDecoder, TextEncoder } from "./encoding.js";

test("implements base64 globals without accepting non-Latin1 input", () => {
	assert.equal(atob("SGVsbG8="), "Hello");
	assert.equal(atob(" YQ == \n"), "a");
	assert.equal(btoa("hello\0ÿ"), "aGVsbG8A/w==");
	assert.throws(() => atob("%%%"), {
		name: "InvalidCharacterError",
		message:
			"atob() called with invalid base64-encoded data. (Only whitespace, '+', '/', alphanumeric ASCII, and up to two terminal '=' signs when the input data length is divisible by 4 are allowed.)",
	});
	assert.throws(() => btoa("✓"), {
		name: "InvalidCharacterError",
		message:
			"btoa() can only operate on characters in the Latin1 (ISO/IEC 8859-1) range.",
	});
});

test("implements UTF-8 encoding, bounded writes, and streaming decoding", () => {
	const encoder = new TextEncoder();
	assert.equal(encoder.encoding, "utf-8");
	assert.deepEqual([...encoder.encode("A💩")], [65, 240, 159, 146, 169]);

	const destination = new Uint8Array(4);
	assert.deepEqual(encoder.encodeInto("A💩B", destination), {
		read: 1,
		written: 1,
	});
	assert.deepEqual([...destination], [65, 0, 0, 0]);

	const decoder = new TextDecoder();
	assert.equal(decoder.decode(new Uint8Array([0xe2, 0x82]), { stream: true }), "");
	assert.equal(decoder.decode(new Uint8Array([0xac]), { stream: false }), "€");
	assert.equal(decoder.encoding, "utf-8");
	assert.equal(decoder.fatal, false);
	assert.equal(decoder.ignoreBOM, false);
});

test("implements fatal decoding", () => {
	const decoder = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: false,
	});
	assert.throws(() => decoder.decode(new Uint8Array([0xff])), {
		name: "TypeError",
		message: "Failed to decode input.",
	});
	assert.throws(() => new TextDecoder("not-an-encoding"), {
		name: "RangeError",
		message: '"not-an-encoding" is not a valid encoding.',
	});
});
