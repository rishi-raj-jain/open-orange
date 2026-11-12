import assert from "node:assert/strict";
import test from "node:test";

import {
	DurableObject,
	type DurableObjectFacets,
	type DurableObjectState,
	type DurableObjectStorage,
} from "./durable-object.js";

class TestDurableObject extends DurableObject<
	{ binding: string },
	{ id: string }
> {
	inspect(): {
		ctx: DurableObjectState<{ id: string }>;
		env: { binding: string };
	} {
		return { ctx: this.ctx, env: this.env };
	}
}

test("preserves the Durable Object state and environment", () => {
	const storage: DurableObjectStorage = Object.create(null);
	const ctx: DurableObjectState<{ id: string }> = {
		abort: () => undefined,
		acceptWebSocket: () => undefined,
		blockConcurrencyWhile: (callback) => callback(),
		get exports(): object {
			throw new Error("not used");
		},
		get facets(): DurableObjectFacets {
			throw new Error("not used");
		},
		getWebSocketAutoResponse: () => null,
		getWebSocketAutoResponseTimestamp: () => null,
		getHibernatableWebSocketEventTimeout: () => null,
		getTags: () => [],
		getWebSockets: () => [],
		id: {
			equals: () => true,
			toString: () => "object-id",
		},
		props: { id: "object-id" },
		storage,
		setHibernatableWebSocketEventTimeout: () => undefined,
		setWebSocketAutoResponse: () => undefined,
		waitUntil: () => undefined,
	};
	const env = { binding: "binding-value" };
	const instance = new TestDurableObject(ctx, env);

	assert.deepEqual(instance.inspect(), { ctx, env });
	assert.ok(instance instanceof DurableObject);
});
