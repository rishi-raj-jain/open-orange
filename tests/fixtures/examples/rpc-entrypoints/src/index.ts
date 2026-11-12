import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

interface Env {
	GREETER: Service<Greeter>;
	COUNTER: DurableObjectNamespace<Counter>;
}

// A named entrypoint. Any Worker with a service binding to it can call its
// methods over RPC.
export class Greeter extends WorkerEntrypoint<Env> {
	greet(name: string): string {
		return `Hello, ${name}!`;
	}
}

// An RpcTarget is passed by reference. The caller gets a stub, and every call
// on that stub runs here, inside the Durable Object.
class Tally extends RpcTarget {
	constructor(private readonly storage: DurableObjectStorage) {
		super();
	}

	total(): number {
		return this.storage.kv.get<number>("total") ?? 0;
	}

	add(amount: number): number {
		if (!Number.isInteger(amount) || amount <= 0) {
			// The caller receives this error from its RPC call.
			throw new RangeError("amount must be a positive integer");
		}
		const total = this.total() + amount;
		this.storage.kv.put("total", total);
		return total;
	}
}

export class Counter extends DurableObject<Env> {
	tally(): Tally {
		return new Tally(this.ctx.storage);
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/greet") {
			const name = url.searchParams.get("name") ?? "World";
			return new Response(await env.GREETER.greet(name));
		}

		const name = /^\/counters\/([\w-]+)$/.exec(url.pathname)?.[1];
		if (name === undefined) {
			return new Response("Try /greet?name=Ada or /counters/<name>", { status: 404 });
		}
		// `using` disposes the stub when the request ends.
		using tally = await env.COUNTER.getByName(name).tally();
		if (request.method !== "POST") {
			return Response.json({ total: await tally.total() });
		}
		try {
			const amount = Number(url.searchParams.get("amount") ?? 1);
			return Response.json({ total: await tally.add(amount) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return Response.json({ error: message }, { status: 400 });
		}
	},
} satisfies ExportedHandler<Env>;
