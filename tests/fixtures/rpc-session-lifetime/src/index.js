import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

class BootTarget extends RpcTarget {
	#object;

	constructor(object) {
		super();
		this.#object = object;
	}

	getBoot() {
		return this.#object.getBoot();
	}
}

export class Obj extends DurableObject {
	boot = crypto.randomUUID();

	getBoot() {
		return this.boot;
	}

	// Returning functions makes this call open an RPC session.
	init() {
		return { getBoot: this.getBoot.bind(this) };
	}

	initTarget() {
		return new BootTarget(this);
	}

	async record(value) {
		await this.ctx.storage.put("recorded", value);
	}

	recorded() {
		return this.ctx.storage.get("recorded");
	}

	dynamicWorkerCode() {
		return {
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `
					import { WorkerEntrypoint } from "cloudflare:workers";
					export class Reader extends WorkerEntrypoint {
						async boot(name) {
							const session = await this.env.HOST.openTarget(name);
							const boot = await session.getBoot();
							session[Symbol.dispose]();
							return boot;
						}

						async bootFromFunctions(name) {
							const session = await this.env.HOST.open(name);
							return await session.getBoot();
						}
					}
				`,
			},
			env: { HOST: this.ctx.exports.Relay({}) },
		};
	}

	// The Dynamic Worker reaches back through a WorkerEntrypoint and uses the session it returns.
	async bootThroughDynamicWorker(name) {
		const worker = this.env.LOADER.get(`relay-${name}`, () => this.dynamicWorkerCode());
		return await worker.getEntrypoint("Reader").boot(name);
	}

	async bootFromFunctionsThroughDynamicWorker(name) {
		const worker = this.env.LOADER.get(`relay-${name}`, () => this.dynamicWorkerCode());
		return await worker.getEntrypoint("Reader").bootFromFunctions(name);
	}
}

// Returns a session to its caller, so the session must outlive this call.
export class Relay extends WorkerEntrypoint {
	async open(name) {
		return await this.env.OBJ.getByName(name).init();
	}

	async openTarget(name) {
		return await this.env.OBJ.getByName(name).initTarget();
	}

	// One entrypoint returns what another entrypoint returned.
	async openThroughRelay(name) {
		return await this.ctx.exports.Relay.open(name);
	}
}

// Outlives the event that made it, which is the mistake this fixture tests.
let kept;

export default {
	async fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);
		const obj = env.OBJ.getByName("a");
		switch (pathname) {
			case "/session": {
				const session = await obj.init();
				kept = session;
				return new Response(await session.getBoot());
			}
			case "/relayed": {
				const session = await ctx.exports.Relay.open("a");
				kept = session;
				return new Response(await session.getBoot());
			}
			case "/relayed-twice": {
				const session = await ctx.exports.Relay.openThroughRelay("a");
				return new Response(await session.getBoot());
			}
			case "/dynamic-worker-functions":
				try {
					return new Response(await env.OBJ.getByName("e").bootFromFunctionsThroughDynamicWorker("f"));
				} catch (error) {
					return new Response(`rejected ${error.message}`);
				}
			case "/dynamic-worker":
				try {
					return new Response(await env.OBJ.getByName("b").bootThroughDynamicWorker("c"));
				} catch (error) {
					return new Response(`rejected ${error.message}`);
				}
			case "/kept": {
				try {
					return new Response(`answered ${await kept.getBoot()}`);
				} catch (error) {
					return new Response(`rejected ${error.message}`);
				}
			}
			case "/wait-until": {
				const session = await obj.init();
				ctx.waitUntil(
					(async () => {
						await new Promise((resolve) => setTimeout(resolve, 500));
						await obj.record(await session.getBoot());
					})(),
				);
				return new Response("sent");
			}
			case "/recorded":
				return new Response(String(await obj.recorded()));
			case "/boot":
				return new Response(await obj.getBoot());
			default:
				return new Response("not found", { status: 404 });
		}
	},
};
