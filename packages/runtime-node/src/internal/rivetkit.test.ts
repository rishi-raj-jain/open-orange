import assert from "node:assert/strict";
import test from "node:test";

import { createRivetActorClient } from "./rivetkit.js";

test("creates stateless get-or-create handles with the pinned RivetKit client", async () => {
	const client = createRivetActorClient({
		endpoint: "http://127.0.0.1:1",
		namespace: "default",
	});
	const handle = client.getOrCreate("openorange_fixture", [
		"deployment",
		"Counter",
		"",
		"canonical-id",
	]);

	assert.equal(typeof handle, "object");
	await client.dispose();
});
