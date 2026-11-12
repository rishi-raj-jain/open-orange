import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export class Unit extends DurableObject {
	override async fetch(): Promise<Response> {
		const value = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
		await this.ctx.storage.put("n", value);
		return Response.json({ value });
	}
}

export class Flow extends WorkflowEntrypoint {
	override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<string> {
		return await step.do("one", async () => "done");
	}
}

interface Env {
	UNIT: DurableObjectNamespace;
	FLOW: Workflow;
	[binding: string]: any;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const [, kind, name = "", value = ""] = url.pathname.split("/");
		switch (kind) {
			case "do":
				return env.UNIT.get(env.UNIT.idFromName(name)).fetch(request);
			case "kv":
				await env[`KV_${name}`].put("k", "v");
				return Response.json({ value: await env[`KV_${name}`].get("k") });
			case "d1":
				return Response.json((await env[`D1_${name}`].prepare("SELECT 1 AS v").all()).results);
			case "r2":
				await env[`R2_${name}`].put("k", "v");
				return Response.json({ value: await (await env[`R2_${name}`].get("k"))?.text() });
			case "queue":
				await env[`QUEUE_${name}`].send({ at: Date.now() });
				return Response.json({ sent: true });
			case "limit":
				return Response.json(await env[`LIMIT_${name}`].limit({ key: "k" }));
			case "cache-default": {
				const key = `https://cache.test/${name}`;
				await caches.default.put(key, new Response("cached", { headers: { "cache-control": "max-age=60" } }));
				return Response.json({ value: await (await caches.default.match(key))?.text() });
			}
			case "cache-named": {
				const cache = await caches.open(name);
				const key = `https://cache.test/${value}`;
				await cache.put(key, new Response("cached", { headers: { "cache-control": "max-age=60" } }));
				return Response.json({ value: await (await cache.match(key))?.text() });
			}
			case "flow": {
				const instance = await env.FLOW.create({ id: name });
				return Response.json({ id: instance.id });
			}
			default:
				return new Response("not found", { status: 404 });
		}
	},
};
