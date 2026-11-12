import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

// Each binding is configured and called once. A clear error is what a stub owes a caller, and it still fails.
// Send Email, inbound email, and Browser Rendering have their own probes: email and browser-rendering.
const scenario: Scenario = async (t) => {
	for (const [name, path] of [
		["Vectorize: query() runs", "/vectorize"],
		["Images: info() runs", "/images"],
		["Pipelines: send() runs", "/pipeline"],
		["mTLS certificates: fetch() runs", "/mtls"],
	] as const) {
		await t.step(name, "binding", async () => {
			const body = await t.json(path);
			assert.equal(body.ok, true, body.error);
		});
	}
};

export default scenario;
