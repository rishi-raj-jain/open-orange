import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

interface Env {
	BAD_FETCH: DurableObjectNamespace<BadFetch>;
	NO_FETCH: Fetcher;
	THROWER: Fetcher;
	OBJECTS: DurableObjectNamespace<Objects>;
	PROPS: Service<Props>;
	PROPS_SET: Service<Props>;
	SELF: Fetcher;
}

export class NoFetch extends WorkerEntrypoint {
	ping(): string {
		return "pong";
	}
}

class QuotaError extends Error {
	readonly code = 7;

	constructor(message: string) {
		super(message);
		this.name = "QuotaError";
	}
}

export class Thrower extends WorkerEntrypoint {
	override async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname === "/custom") throw new QuotaError("over quota");
		throw new TypeError("bad input");
	}
}

export class Props extends WorkerEntrypoint {
	read(): unknown {
		return this.ctx.props;
	}
}

// Has no fetch() handler.
export class Objects extends DurableObject {
	ping(): string {
		return "pong";
	}
}

export class BadFetch extends DurableObject {
	override async fetch(): Promise<Response> {
		return "not a Response" as unknown as Response;
	}
}

function describeError(error: unknown): unknown {
	if (!(error instanceof Error)) return { thrown: String(error) };
	return {
		code: Reflect.get(error, "code"),
		isTypeError: error instanceof TypeError,
		message: error.message,
		name: error.name,
		remote: Reflect.get(error, "remote"),
	};
}

async function settle(promise: Promise<Response>): Promise<unknown> {
	try {
		const response = await promise;
		return { status: response.status, body: await response.text() };
	} catch (error) {
		return { error: describeError(error) };
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/pass-through") {
			ctx.passThroughOnException();
			return new Response("handled");
		}
		if (pathname === "/pass-through-then-throw") {
			ctx.passThroughOnException();
			throw new Error("handler failure");
		}
		if (pathname === "/props-echo") return Response.json(ctx.props);
		if (pathname === "/copy-context") {
			// As Sentry's instrumentContext does: read every own and prototype property.
			const names = new Set<string>();
			for (let object: object | null = ctx; object !== null && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
				for (const name of Object.getOwnPropertyNames(object)) names.add(name);
			}
			const copy: Record<string, string> = {};
			for (const name of [...names].sort()) copy[name] = typeof Reflect.get(ctx, name);
			return Response.json({ cache: copy.cache, access: copy.access, waitUntil: copy.waitUntil });
		}
		if (pathname === "/props") {
			return Response.json({
				request: ctx.props,
				serviceFetch: await (await env.SELF.fetch("http://self/props-echo")).json(),
				entrypoint: await env.PROPS.read(),
				entrypointWithProps: await env.PROPS_SET.read(),
			});
		}
		if (pathname === "/non-response") return "not a Response" as unknown as Response;
		if (pathname === "/no-fetch") {
			return Response.json({
				entrypoint: await settle(env.NO_FETCH.fetch("http://entrypoint/")),
				durableObject: await settle(env.OBJECTS.getByName("no-fetch").fetch("http://object/")),
				nonResponse: await settle(env.SELF.fetch("http://self/non-response")),
				durableObjectNonResponse: await settle(env.BAD_FETCH.getByName("bad").fetch("http://object/")),
				thrown: await settle(env.THROWER.fetch("http://thrower/")),
				thrownCustom: await settle(env.THROWER.fetch("http://thrower/custom")),
			});
		}
		return new Response("not found", { status: 404 });
	},
};
