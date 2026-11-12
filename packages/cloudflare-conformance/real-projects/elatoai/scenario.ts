import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const auth = { type: "auth", volume_control: 100, pitch_factor: 1, is_ota: false, is_reset: false };

const scenario: Scenario = async (t) => {
	await t.step("the health check answers, and other paths get 404", "http", async () => {
		assert.deepEqual(await t.json("/healthz"), { ok: true, backend: "cloudflare-voice" });
		await t.text("/other", undefined, 404);
	});

	await t.step("the session object refuses a request that is not a WebSocket", "do-state", async () => {
		assert.equal(await t.text("/ws/esp32", undefined, 426), "Expected websocket");
	});

	await t.step("two devices each get a session and the auth payload, and a missing LLM key ends each one cleanly", "websocket", async () => {
		const devices = await Promise.all([t.webSocket("/ws/esp32"), t.webSocket("/ws/esp32")]);
		for (const device of devices) {
			assert.deepEqual(JSON.parse(await device.next()), auth);
			assert.deepEqual(JSON.parse(await device.next()), { type: "server", msg: "RESPONSE.ERROR" });
			await assert.rejects(device.next(), /WebSocket closed \(1011 startup_failed\)/);
		}
	});

	t.needsSecrets("the device hears a spoken reply and its speech is transcribed", "binding", ["OPENAI_API_KEY", "Workers AI"]);
};

export default scenario;
