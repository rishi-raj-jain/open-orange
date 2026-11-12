import type { RivetActorHandle, RivetWebSocket } from "../../internal/rivetkit.js";

// Builds a RivetKit actor handle for tests. Methods a test does not pass reject.
export function fakeRivetActorHandle(methods: Partial<RivetActorHandle> = {}): RivetActorHandle {
	const unused = (name: string) => async (): Promise<never> => {
		throw new Error(`The test actor handle does not implement ${name}()`);
	};
	return {
		action: methods.action ?? unused("action"),
		fetch: methods.fetch ?? unused("fetch"),
		webSocket: methods.webSocket ?? unused("webSocket"),
	};
}

const testActorId = "test-actor";

interface TestActorConfig {
	onRequest(context: { actorId: string; vars: unknown }, request: Request): Response | Promise<Response>;
	onWebSocket(
		context: { actorId: string; request: Request; vars: unknown },
		webSocket: RivetWebSocket,
	): void | Promise<void>;
}

/** Sends a request to an actor definition the way the Orange runtime does. */
export function runtimeActorRequest(
	config: Pick<TestActorConfig, "onRequest">,
	vars: unknown,
	request: Request,
): Response | Promise<Response> {
	return config.onRequest({ actorId: testActorId, vars }, request);
}

/** Opens a WebSocket on an actor definition the way the Orange runtime does. */
export async function runtimeActorWebSocket(
	config: TestActorConfig,
	vars: unknown,
	path: string,
	webSocket: RivetWebSocket,
): Promise<void> {
	await config.onWebSocket(
		{ actorId: testActorId, request: new Request(`http://actor/websocket${path}`), vars },
		webSocket,
	);
}
