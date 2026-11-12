export const durableObjectPrivateRoutes = {
	fetch: "/__open-orange/durable-object/fetch",
	rpc: "/__open-orange/durable-object/rpc",
	webSocket: "/__open-orange/durable-object/websocket",
	webSocketDisconnect: "/__open-orange/durable-object/websocket/disconnect",
	webSocketPrepare: "/__open-orange/durable-object/websocket/prepare",
} as const;

/** The `x-rivet-error` of a request that reached a retired generation before the object ran it. */
export const generationRetiredError = "openorange.generation_retired";
