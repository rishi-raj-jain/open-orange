import { setTimeout as delay } from "node:timers/promises";

import { reportError } from "../../../globals/global-scope.js";
import {
	currentDurableObjectOutputGate,
	holdOutgoingFrames,
} from "../../../internal/output-gate.js";
import {
	type RivetActorHandle,
} from "../../../internal/rivetkit.js";
import { extendsDurableObject } from "../../../modules/cloudflare-workers/durable-object.js";
import { durableObjectPrivateRoutes, generationRetiredError } from "../routes.js";
import type { DurableObjectGeneration } from "../state.js";
import {
	requireDurableObjectStubOrder,
	type DurableObjectStubLifecycle,
	type DurableObjectStubOrder,
} from "../ordering.js";
import {
	encodeRpcValue,
	markDurableObjectResetRpcError,
	type RpcValueEnvelope,
} from "./codec.js";
import {
	createDurableObjectRpcPromise,
	createLazyDurableObjectRpcProperty,
} from "./promise.js";
import {
	callEncodedDurableObjectRpc,
	type DurableObjectRpcCallResult,
} from "./session.js";

export const durableObjectRpcContinuationParameter = "continuation";

const reservedMethodNames: ReadonlySet<string> = new Set([
	"alarm",
	"connect",
	"dup",
	"fetch",
	"then",
	"webSocketClose",
	"webSocketError",
	"webSocketMessage",
]);

export function isDurableObjectReservedRpcMethod(name: string): boolean {
	return reservedMethodNames.has(name) || Reflect.has(Object.prototype, name);
}

interface DurableObjectMethodCall {
	readonly args: readonly unknown[];
	readonly methodName: string;
	readonly operation: "call" | "get";
	readonly order: DurableObjectStubOrder;
}

function requireMethodCall(value: unknown): DurableObjectMethodCall {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Durable Object RPC method call must be an object");
	}
	const methodName: unknown = Reflect.get(value, "methodName");
	const args: unknown = Reflect.get(value, "args");
	const operation: unknown = Reflect.get(value, "operation");
	const order = requireDurableObjectStubOrder(Reflect.get(value, "order"));
	if (typeof methodName !== "string" || methodName.length === 0) {
		throw new TypeError("Durable Object RPC method name is invalid");
	}
	if (!Array.isArray(args)) {
		throw new TypeError("Durable Object RPC arguments must be an array");
	}
	if (operation !== "call" && operation !== "get") {
		throw new TypeError("Durable Object RPC operation is invalid");
	}
	if (isDurableObjectReservedRpcMethod(methodName)) {
		throw new TypeError(`Durable Object method ${methodName} is reserved`);
	}
	return { args, methodName, operation, order };
}

// Orange's compatibility profile leaves `js_rpc` off, so a class that does not
// extend DurableObject cannot receive RPC.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-rpc.c%2B%2B#L2302-L2310
function missingSuperclassError(): TypeError {
	return new TypeError(
		"The receiving Durable Object does not support RPC, because its class was not declared with `extends DurableObject`. In order to enable RPC, make sure your class extends the special class `DurableObject`, which can be imported from the module \"cloudflare:workers\".",
	);
}

// workerd's lookup error for a missing or own-instance property.
// https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/api/worker-rpc.c%2B%2B#L1300-L1303
function missingMethodError(methodName: string): TypeError {
	return new TypeError(`The RPC receiver does not implement the method "${methodName}".`);
}

const generationLaneKeys = new WeakMap<DurableObjectGeneration, Set<string>>();

// A stub that reached a generation breaks when that generation resets, so its
// later calls fail with the reset error instead of reaching the next one.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/js-rpc-test.js#L2155-L2193
function trackStubLane(generation: DurableObjectGeneration, key: string): void {
	const resetSignal = generation.stateController.resetSignal;
	let keys = generationLaneKeys.get(generation);
	if (keys === undefined) {
		const tracked = new Set<string>();
		keys = tracked;
		generationLaneKeys.set(generation, tracked);
		resetSignal.addEventListener(
			"abort",
			() => {
				for (const laneKey of tracked) {
					generation.orderCoordinator.poisonLane(laneKey, resetSignal.reason);
				}
			},
			{ once: true },
		);
	}
	keys.add(key);
}

export function createDurableObjectMethodHandler(
	generation: DurableObjectGeneration,
): (value: unknown) => Promise<unknown> {
	return async (value): Promise<unknown> => {
		const call = requireMethodCall(value);
		trackStubLane(generation, call.order.key);
		try {
			return await generation.orderCoordinator.run(call.order, () =>
				generation.stateController.runEvent(() => {
					if (!extendsDurableObject(generation.instance)) {
						throw missingSuperclassError();
					}
					if (Object.hasOwn(generation.instance, call.methodName)) {
						throw missingMethodError(call.methodName);
					}
					const member: unknown = Reflect.get(generation.instance, call.methodName);
					if (call.operation === "get") return member;
					if (member === undefined) throw missingMethodError(call.methodName);
					if (typeof member !== "function") {
						throw new TypeError(`"${call.methodName}" is not a function.`);
					}
					return Reflect.apply(member, generation.instance, [...call.args]);
				}),
			);
		} catch (error) {
			// A reset breaks the caller's stub, as in workerd. Errors that the
			// object's own code throws leave the stub usable.
			if (generation.stateController.resetSignal.aborted) markDurableObjectResetRpcError(error);
			throw error;
		}
	};
}

const admissionRetryLimit = 5;
const admissionRetryDelayMilliseconds = 25;

// Envoy answers 503 with one of these codes when it rejects a request before the actor admits it:
// the routed generation already stopped, or the actor is not on that envoy yet. The object never
// saw the call. RivetKit returns these responses to the caller instead of retrying them, because
// a streamed body may already be partly sent. An RPC batch body is a buffered string, so Orange
// resends it, and the gateway routes the retry to the object's next generation.
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/engine/sdks/rust/envoy-client/src/tunnel.rs#L481-L551
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-typescript/packages/rivetkit/src/client/actor-handle.ts#L535-L558
// Orange answers the same way for a generation that ctx.abort(), sleep, or destroy retired.
// The v3 gateway replaces both envoy codes with guard.actor_stopped_while_waiting.
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/engine/packages/pegboard-gateway/src/http_tunnel.rs#L313-L340
const admissionRejections: ReadonlySet<string> = new Set([
	"envoy.actor_generation_mismatch",
	"envoy.actor_not_found",
	"guard.actor_stopped_while_waiting",
	generationRetiredError,
]);

// A retired generation answers until RivetKit stops its actor and starts the next one, which can
// take seconds on a busy host, so those rejections get a longer budget.
const retiredGenerationRetryLimit = 40;
const retryDelayCapMilliseconds = 250;

async function fetchDurableObjectRpc(
	handle: RivetActorHandle,
	request: Request,
): Promise<Response> {
	for (let attempt = 1; ; attempt += 1) {
		const response = await handle.fetch(request.clone());
		const rejection = response.headers.get("x-rivet-error") ?? "";
		const limit =
			rejection === generationRetiredError ? retiredGenerationRetryLimit : admissionRetryLimit;
		if (attempt >= limit || response.status !== 503 || !admissionRejections.has(rejection)) {
			return response;
		}
		await response.body?.cancel();
		await delay(
			Math.min(admissionRetryDelayMilliseconds * attempt, retryDelayCapMilliseconds),
			undefined,
			{ signal: request.signal },
		);
	}
}

function startDurableObjectStubOperation(
	handle: RivetActorHandle,
	call: RpcValueEnvelope,
	signal: AbortSignal,
	durableObjectId: string,
): Promise<DurableObjectRpcCallResult> {
	return callEncodedDurableObjectRpc(
		call,
		{
			durableObjectId,
			signal,
			connector: {
				async open(continuation) {
					const url = new URL(
						durableObjectPrivateRoutes.rpc,
						"http://actor",
					);
					if (continuation !== undefined) {
						url.searchParams.set(
							durableObjectRpcContinuationParameter,
							continuation.token,
						);
					}
					// Calls on stubs that the session returns are RPC calls out too, so a
					// Durable Object caller holds their frames on its output gate.
					const webSocket = holdOutgoingFrames(
						await handle.webSocket(`${url.pathname}${url.search}`),
						currentDurableObjectOutputGate(),
						reportError,
					);
					return {
						release(): void {
							if (webSocket.readyState < 2) {
								webSocket.close(1000, "Durable Object RPC complete");
							}
						},
						webSocket,
					};
				},
			},
			endpoint: `http://actor${durableObjectPrivateRoutes.rpc}`,
			fetch: (request) => fetchDurableObjectRpc(handle, request),
		},
	);
}

export function createDurableObjectStubRpcProperty(
	handle: () => RivetActorHandle,
	lifecycle: DurableObjectStubLifecycle,
	methodName: string,
	durableObjectId: string,
): object {
	const start = (
		args: readonly unknown[],
		operation: "call" | "get",
	): object => {
		const started = lifecycle.startPrepared(
			(order) => encodeRpcValue({ args: [...args], methodName, operation, order }),
			(call, signal) =>
				startDurableObjectStubOperation(handle(), call, signal, durableObjectId),
		);
		return createDurableObjectRpcPromise(
			started.promise,
			started.abortController,
		);
	};
	return createLazyDurableObjectRpcProperty(
		() => start([], "get"),
		(args) => start(args, "call"),
	);
}

// workerd rejects reserved, Object-prototype, and own class-instance properties,
// then invokes the callable prototype property with the instance as `this`.
// https://github.com/cloudflare/workerd/blob/dc27e996c4ab8e8849cc6229ae816b3d426f08ef/src/workerd/api/worker-rpc.c%2B%2B#L1429-L1578
