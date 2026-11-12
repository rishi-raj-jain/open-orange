import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { crypto, DigestStream } from "./crypto.js";

test("implements Web Crypto randomness and timing-safe comparison", () => {
	assert.match(crypto.randomUUID(), /^[0-9a-f-]{36}$/);
	const random = crypto.getRandomValues(new Uint8Array(16));
	assert.equal(random.byteLength, 16);
	assert.equal(
		crypto.subtle.timingSafeEqual(random, Uint8Array.from(random)),
		true,
	);
});

test("streams supported digests and counts input bytes", async () => {
	const stream = new DigestStream("SHA-256");
	const writer = stream.getWriter();
	await writer.write(new TextEncoder().encode("open"));
	await writer.write(new TextEncoder().encode("orange"));
	await writer.close();
	assert.equal(stream.bytesWritten, 10);
	assert.equal(
		Buffer.from(await stream.digest).toString("hex"),
		createHash("sha256").update("openorange").digest("hex"),
	);
});
