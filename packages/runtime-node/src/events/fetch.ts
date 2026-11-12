import {
	createExecutionContext,
	runInExecutionContext,
	type ExecutionContext,
} from "../context.js";
import { Request, Response } from "../globals/http.js";
import {
	fetchTraceEvent,
	finishEventTrace,
	startEventTrace,
	traceEventException,
	traceFetchResponse,
} from "../internal/tail-trace.js";

export type FetchHandler<Props = unknown> = (
	request: Request,
	environment: Record<string, unknown>,
	context: ExecutionContext<Props>,
) => Response | Promise<Response>;

export interface FetchDispatch<Props = unknown> {
	response: Response;
	waitUntil: Promise<PromiseSettledResult<unknown>[]>;
	/** Ends the event after its response is sent and its waitUntil() tasks settle. */
	end(): void;
}

export interface FetchDispatchOptions<Props> {
	environment: Record<string, unknown>;
	exports: object;
	handler: FetchHandler<Props>;
	props: Props;
	request: Request;
}

// Built outside dispatchFetch, so an upgraded socket that holds `end` does not hold the request.
function fetchEventEnd(
	context: ExecutionContext<unknown>,
	controller: { end(): void },
): () => void {
	return () => {
		finishEventTrace(context);
		controller.end();
	};
}

export async function dispatchFetch<Props>(
	options: FetchDispatchOptions<Props>,
): Promise<FetchDispatch<Props>> {
	const controller = createExecutionContext({
		exports: options.exports,
		props: options.props,
	});
	const context = controller.context;
	startEventTrace(context, fetchTraceEvent(options.request));
	const end = fetchEventEnd(context, controller);
	const fail = async (error: unknown): Promise<never> => {
		traceEventException(context, error);
		await controller.drainWaitUntil();
		end();
		throw error;
	};
	let result: unknown;
	try {
		result = await runInExecutionContext(context, () =>
			Reflect.apply(options.handler, undefined, [options.request, options.environment, context]),
		);
	} catch (error: unknown) {
		return await fail(error);
	}
	if (!(result instanceof Response)) {
		return await fail(new TypeError("Worker fetch handler must return a Response"));
	}
	try {
		validateServedResponse(result);
	} catch (error: unknown) {
		return await fail(error);
	}
	traceFetchResponse(context, result.status);
	return {
		response: result,
		waitUntil: controller.drainWaitUntil(),
		end,
	};
}

/** Rejects a handler's Response that workerd refuses to send. */
export function validateServedResponse(response: Response): void {
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L449-L450
	if (response.type === "error") {
		throw new TypeError(
			"Return value from serve handler must not be an error response (like Response.error())",
		);
	}
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L1234-L1236
	if (response.bodyUsed) {
		throw new TypeError(
			"Body has already been used. It can only be used once. Use tee() first if you need to read it twice.",
		);
	}
}
