import { DurableObject } from "cloudflare:workers";

interface Env {
	THROWER: DurableObjectNamespace<Thrower>;
}

class QuotaError extends Error {
	readonly code = 7;

	constructor(message: string) {
		super(message);
		this.name = "QuotaError";
	}
}

export class Thrower extends DurableObject<Env> {
	echo(value: unknown): unknown {
		return value;
	}

	fail(kind: string): never {
		if (kind === "type") throw new TypeError("bad input");
		if (kind === "custom") throw new QuotaError("over quota");
		throw new Error("app failure");
	}

	async slow(milliseconds: number): Promise<string> {
		await scheduler.wait(milliseconds);
		return "slow done";
	}

	override async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname === "/throw") throw new Error("fetch failure");
		return new Response("fetched");
	}

	reset(): void {
		this.ctx.abort("reset by test");
	}
}

function describeError(error: unknown): unknown {
	if (!(error instanceof Error)) return { thrown: String(error) };
	return {
		code: Reflect.get(error, "code"),
		isDOMException: error instanceof DOMException,
		isTypeError: error instanceof TypeError,
		// workerd's DOMException has own fields that Node's lacks; callers read them the same way.
		keys: error instanceof DOMException ? undefined : Object.keys(error).sort(),
		message: error.message,
		name: error.name,
	};
}

async function settle(promise: Promise<unknown>): Promise<unknown> {
	try {
		return { value: await promise };
	} catch (error) {
		return { error: describeError(error) };
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		const stub = env.THROWER.getByName(pathname);
		if (pathname === "/keeps") {
			return Response.json({
				error: await settle(stub.fail("error")),
				afterError: await settle(stub.echo(1)),
				typeError: await settle(stub.fail("type")),
				afterTypeError: await settle(stub.echo(2)),
				customError: await settle(stub.fail("custom")),
				afterCustomError: await settle(stub.echo(3)),
			});
		}
		if (pathname === "/in-flight") {
			const slow = settle(stub.slow(300));
			const failed = await settle(stub.fail("error"));
			return Response.json({ failed, slow: await slow, after: await settle(stub.echo(4)) });
		}
		if (pathname === "/missing-method") {
			const loose = stub as unknown as Record<string, () => Promise<unknown>>;
			return Response.json({
				missing: await settle(loose.nope!()),
				afterMissing: await settle(stub.echo(10)),
				numericName: env.THROWER.idFromName(5 as unknown as string).equals(env.THROWER.idFromName("5")),
			});
		}
		if (pathname === "/unserializable") {
			return Response.json({
				symbol: await settle(stub.echo(Symbol("s"))),
				afterSymbol: await settle(stub.echo(8)),
				weakMap: await settle(stub.echo(new WeakMap()).then(() => "sent")),
				afterWeakMap: await settle(stub.echo(9)),
			});
		}
		if (pathname === "/abort-breaks") {
			return Response.json({
				reset: await settle(stub.reset()),
				afterReset: await settle(stub.echo(5)),
				freshStub: await settle(env.THROWER.getByName(pathname).echo(6)),
			});
		}
		if (pathname === "/fetch-throws") {
			const thrown = await settle(stub.fetch("http://object/throw").then(async (response) => ({ status: response.status, body: await response.text() })));
			return Response.json({
				thrown,
				afterFetch: await settle(stub.fetch("http://object/ok").then((response) => response.text())),
				afterRpc: await settle(stub.echo(7)),
			});
		}
		return new Response("not found", { status: 404 });
	},
};
