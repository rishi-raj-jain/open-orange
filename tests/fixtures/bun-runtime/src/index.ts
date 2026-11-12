import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

interface Env {
	COUNTER: DurableObjectNamespace<Counter>;
	ECHO: Workflow<{ label: string }>;
	KV: KVNamespace;
}

export class Counter extends DurableObject<Env> {
	increment(): number {
		const value = (this.ctx.storage.kv.get<number>("count") ?? 0) + 1;
		this.ctx.storage.kv.put("count", value);
		return value;
	}
}

export class Echo extends WorkflowEntrypoint<Env, { label: string }> {
	async run(event: WorkflowEvent<{ label: string }>, step: WorkflowStep): Promise<string> {
		return step.do("echo", async () => `echo ${event.payload.label}`);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/counter":
				return Response.json(await env.COUNTER.getByName("counter").increment());
			case "/kv": {
				const value = url.searchParams.get("value");
				if (value !== null) await env.KV.put("key", value);
				return Response.json(await env.KV.get("key"));
			}
			case "/workflow": {
				const instance = await env.ECHO.create({ params: { label: "hello" } });
				return Response.json(instance.id);
			}
			case "/workflow-status": {
				const instance = await env.ECHO.get(url.searchParams.get("id") ?? "");
				return Response.json(await instance.status());
			}
			default:
				return new Response("not found", { status: 404 });
		}
	},
};
