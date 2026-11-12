import { DurableObject, RpcStub, RpcTarget, WorkflowEntrypoint } from "cloudflare:workers";

// Each route goes past a quota that Cloudflare enforces and Orange does not.
const routes = {
	// Workerd caps an event at 10,000 active timeouts.
	async timers(url) {
		const count = Number(url.searchParams.get("count"));
		let fired = 0;
		await Promise.all(Array.from({ length: count }, () => new Promise((resolve) => setTimeout(() => resolve(fired++), 1))));
		return { fired };
	},
	// Workerd caps a Blob at 128 MiB.
	async blob(url) {
		const mib = Number(url.searchParams.get("mib"));
		const blob = new Blob([new Uint8Array(mib * 1024 * 1024).fill(7), "end"]);
		const tail = await blob.slice(blob.size - 4).text();
		return { size: blob.size, tail };
	},
	// Cloudflare KV: 512 B keys, 1 KiB metadata, 25 MiB values, 100 keys per bulk get, 1,000 keys
	// per list, and TTLs of at least 60 s.
	async kv(url, env) {
		const size = (name) => Math.round(Number(url.searchParams.get(name) ?? "0") * 1024);
		const key = "k".repeat(size("keyKiB"));
		const metadata = { m: "m".repeat(size("metadataKiB")) };
		const value = new Uint8Array(size("valueKiB")).fill(5);
		await env.KV.put(key, value, { expirationTtl: 30, metadata });
		const read = await env.KV.getWithMetadata(key, "arrayBuffer");
		const keys = Number(url.searchParams.get("keys") ?? "0");
		const names = Array.from({ length: keys }, (_, index) => `bulk:${String(index).padStart(5, "0")}`);
		for (let start = 0; start < names.length; start += 100) {
			await Promise.all(names.slice(start, start + 100).map((name) => env.KV.put(name, name)));
		}
		const bulk = keys === 0 ? new Map() : await env.KV.get(names);
		const listed = keys === 0 ? { keys: [] } : await env.KV.list({ prefix: "bulk:", limit: keys });
		return {
			value: read.value?.byteLength,
			metadata: read.metadata?.m.length,
			bulk: [...bulk.values()].filter((entry) => entry !== null).length,
			listed: listed.keys.length,
		};
	},
	// Cloudflare caps a cache name at 1,024 characters.
	async cache(url) {
		const name = "c".repeat(Number(url.searchParams.get("nameLength")));
		const cache = await caches.open(name);
		const key = "https://quotas.example/cached";
		await cache.put(key, new Response("kept", { headers: { "cache-control": "max-age=600" } }));
		const hit = await cache.match(key);
		const other = await (await caches.open("other")).match(key);
		return { hit: await hit?.text(), other: other === undefined ? null : await other.text() };
	},
	// Cloudflare caps a Durable Object storage key and value at 2 MiB together. Orange's bound is
	// Rivet's 128 MiB commit.
	async storage(url, env) {
		const kib = Number(url.searchParams.get("valueKiB"));
		return await env.OBJECT.get(env.OBJECT.idFromName(`storage-${kib}`)).store(kib);
	},
	// Workerd stops blockConcurrencyWhile() nesting at 64.
	async nesting(url, env) {
		return await env.OBJECT.get(env.OBJECT.idFromName("nesting")).nest(Number(url.searchParams.get("depth")));
	},
	// Workerd caps an RPC value at 32 MiB. Rivet's Engine takes 32 MiB per message.
	async rpc(url, env) {
		const bytes = new Uint8Array(Math.round(Number(url.searchParams.get("MiB")) * 1024 * 1024)).fill(2);
		return { echoed: await env.OBJECT.get(env.OBJECT.idFromName("rpc")).size(bytes) };
	},
	// Workerd stops a pipelined RPC property path at 64.
	async properties(url) {
		const depth = Number(url.searchParams.get("depth"));
		class Node extends RpcTarget {
			#level;
			constructor(level) {
				super();
				this.#level = level;
			}
			get level() {
				return this.#level;
			}
			get next() {
				return new Node(this.#level + 1);
			}
		}
		let path = new RpcStub(new Node(0));
		for (let index = 0; index < depth; index += 1) path = path.next;
		return { level: await path.level };
	},
	// Cloudflare Queues: 128 KB per message, delays of at most 24 hours, and 100 messages per batch.
	async queue(url, env) {
		const kib = Number(url.searchParams.get("messageKiB"));
		const run = url.searchParams.get("run");
		await env.QUEUE.send({ run, body: "q".repeat(kib * 1024) });
		await env.QUEUE.send({ run, late: true }, { delaySeconds: 3 * 24 * 60 * 60 });
		await env.QUEUE.sendBatch(Array.from({ length: 250 }, (_, index) => ({ body: { run, index } })));
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const seen = await env.KV.get(`queue:${run}`, "json");
			if (seen !== null && seen.batch === 250) return seen;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return { seen: await env.KV.get(`queue:${run}`, "json") };
	},
	// Cloudflare Workflows: instance IDs of at most 100 characters, step names of at most 256, and
	// at most 100 instances per createBatch().
	async workflows(url, env) {
		const run = url.searchParams.get("run");
		const id = `${run}-${"i".repeat(150)}`;
		const instance = await env.FLOW.create({ id, params: { stepName: "s".repeat(300) } });
		const batch = await env.FLOW.createBatch(Array.from({ length: 150 }, (_, index) => ({ id: `${run}-batch-${index}` })));
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const status = await instance.status();
			if (status.status === "complete" || status.status === "errored") {
				return { batch: batch.length, idLength: instance.id.length, output: status.output ?? status.error };
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return { timedOut: true };
	},
	// Workerd caps a Dynamic Worker's code at 64 MiB and its env at 1 MiB.
	async loader(url, env) {
		// `files` modules of `codeMiB` each, imported by the main module.
		const codeMiB = Number(url.searchParams.get("codeMiB"));
		const files = Number(url.searchParams.get("files") ?? "1");
		const envMiB = Number(url.searchParams.get("envMiB"));
		const modules = {};
		for (let index = 0; index < files; index += 1) {
			modules[`part${index}.js`] = `// ${"p".repeat(codeMiB * 1024 * 1024)}\nexport const part = ${index};`;
		}
		const imports = Object.keys(modules).map((name, index) => `import { part as p${index} } from "./${name}";`).join("\n");
		modules["main.js"] = `${imports}\nexport default { async fetch(request, env) { return new Response(String(env.BIG.length)); } };`;
		const worker = env.LOADER.get(`big-${codeMiB}-${files}-${envMiB}`, () => ({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules,
			env: { BIG: "e".repeat(envMiB * 1024 * 1024) },
		}));
		const response = await worker.getEntrypoint().fetch("https://dynamic.example/");
		return { envLength: Number(await response.text()) };
	},
};

export class Flow extends WorkflowEntrypoint {
	async run(event, step) {
		const stepName = event.payload?.stepName ?? "step";
		return await step.do(stepName, async () => ({ stepNameLength: stepName.length }));
	}
}

export class Quotas extends DurableObject {
	async store(kib) {
		const value = new Uint8Array(kib * 1024).fill(9);
		this.ctx.storage.kv.put("sync", value);
		await this.ctx.storage.put("async", value);
		return {
			async: (await this.ctx.storage.get("async")).byteLength,
			sync: this.ctx.storage.kv.get("sync").byteLength,
		};
	}

	// Accepts a socket with tags, an attachment, and an auto-response past Cloudflare's limits.
	async fetch() {
		const pair = new WebSocketPair();
		const tags = Array.from({ length: 20 }, (_, index) => `${index}-${"t".repeat(300)}`);
		this.ctx.acceptWebSocket(pair[1], tags);
		pair[1].serializeAttachment({ blob: "a".repeat(64 * 1024) });
		const ping = `ping-${"r".repeat(4096)}`;
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(ping, `pong-${"s".repeat(4096)}`));
		this.ctx.setHibernatableWebSocketEventTimeout(20 * 24 * 60 * 60 * 1000);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	webSocketMessage(socket) {
		socket.send(
			JSON.stringify({
				attachment: socket.deserializeAttachment().blob.length,
				tags: this.ctx.getTags(socket).length,
				tagged: this.ctx.getWebSockets(`19-${"t".repeat(300)}`).length,
				timeout: this.ctx.getHibernatableWebSocketEventTimeout(),
			}),
		);
	}

	async nest(depth) {
		const enter = (level) => (level === depth ? level : this.ctx.blockConcurrencyWhile(() => enter(level + 1)));
		return { reached: await enter(0) };
	}

	size(bytes) {
		return bytes.byteLength;
	}
}

export default {
	async queue(batch, env) {
		const run = batch.messages[0].body.run;
		const seen = (await env.KV.get(`queue:${run}`, "json")) ?? { batch: 0, largestBatch: 0, messageBytes: 0 };
		seen.largestBatch = Math.max(seen.largestBatch, batch.messages.length);
		for (const message of batch.messages) {
			if (typeof message.body.body === "string") seen.messageBytes = message.body.body.length;
			if (message.body.index !== undefined) seen.batch += 1;
		}
		await env.KV.put(`queue:${run}`, JSON.stringify(seen));
		batch.ackAll();
	},
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/socket") return env.OBJECT.get(env.OBJECT.idFromName("socket")).fetch(request);
		const route = routes[url.pathname.slice(1)];
		if (route === undefined) return new Response("not found", { status: 404 });
		try {
			return Response.json(await route(url, env));
		} catch (error) {
			return Response.json({ error: `${error?.name}: ${error?.message}` }, { status: 500 });
		}
	},
};
