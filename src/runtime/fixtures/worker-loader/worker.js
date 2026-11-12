import { abortIsolate, DurableObject, WorkerEntrypoint } from "cloudflare:workers";

globalThis.parentMarker = "parent-only";

export class EngineUser extends DurableObject {}

const filesystemCode = {
	compatibilityDate: "2026-09-03",
	mainModule: "main.js",
	modules: {
		"main.js": `
			import { createRequire } from "node:module";
			const fs = createRequire(import.meta.url)("fs");
			export default {
				write(path) { fs.writeFileSync(path, "dynamic secret"); return fs.readFileSync(path, "utf8"); },
				read(path) {
					try { return { content: fs.readFileSync(path, "utf8") }; } catch (error) { return { error: error.code ?? error.message }; }
				},
			};
		`,
	},
};

const loopbackCode = (globalOutbound) => ({
	compatibilityDate: "2026-09-03",
	mainModule: "main.js",
	modules: {
		"main.js": `
			import { createRequire } from "node:module";
			const net = createRequire(import.meta.url)("net");
			function connect(port) {
				return new Promise((resolve) => {
					const socket = net.connect({ host: "127.0.0.1", port });
					const timer = setTimeout(() => { socket.destroy(); resolve("timed out"); }, 3000);
					socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
					socket.once("error", (error) => { clearTimeout(timer); resolve(error.code ?? error.message); });
				});
			}
			export default {
				async probe(ports) {
					const results = {};
					for (const port of ports) {
						let fetched;
						try { fetched = "status " + (await fetch("http://127.0.0.1:" + port + "/")).status; } catch (error) { fetched = "failed"; }
						results[port] = { fetch: fetched, net: await connect(port) };
					}
					return results;
				},
			};
		`,
	},
	...(globalOutbound === undefined ? {} : { globalOutbound }),
});

export class Greeter extends WorkerEntrypoint {
	greet(name) {
		return `${this.ctx.props.greeting}, ${name}!`;
	}
}

const counterCode = {
	compatibilityDate: "2026-09-03",
	mainModule: "main.js",
	modules: {
		"main.js": `
			import { abortIsolate, WorkerEntrypoint } from "cloudflare:workers";
			let count = 0;
			export default class extends WorkerEntrypoint {
				increment() { return ++count; }
				crash() { process.exit(137); }
				abort() { abortIsolate("secret reason"); }
			}
		`,
	},
};

// Describes a value from the "values" route as JSON, so each side can show
// what it received.
function describeValues(v) {
	return {
		bytes: v.bytes instanceof Uint8Array ? [...v.bytes] : null,
		cycle: v.self === v,
		date: v.date instanceof Date ? v.date.toISOString() : null,
		edges: [Object.is(v.negZero, -0), Number.isNaN(v.nan), Object.hasOwn(v, "missing") && v.missing === undefined],
		error: [
			v.error instanceof TypeError,
			v.error.message,
			v.error.stack.startsWith("TypeError: outer"),
			v.error.cause instanceof RangeError,
			v.error.cause.message,
		],
		map: [...v.map].map(([key, entry]) => [
			key,
			typeof entry === "bigint" ? `${entry}n` : entry instanceof Date ? entry.toISOString() : entry,
		]),
		sharedBytes: v.sameBytes === v.bytes,
	};
}

async function settle(promise) {
	try {
		return { value: await promise };
	} catch (error) {
		return { error: { message: error.message, name: error.name } };
	}
}

const routes = {
	async basic(env, ctx) {
		const worker = env.LOADER.get("basic", () => ({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `
					import { WorkerEntrypoint } from "cloudflare:workers";
					import { suffix } from "./lib/util.js";
					export default {
						fetch(request, env) {
							// Stdout output that looks like an RPC frame must reach the
							// log, not the RPC session.
							console.log(JSON.stringify({ openOrangeWorkerLoaderRpc: '["abort",["error","Error","dynamic Worker stdout"]]' }));
							return new Response(new URL(request.url).pathname + " " + env.hello + suffix, {
								headers: { "x-dynamic": "yes" },
							});
						},
					};
					export class Named extends WorkerEntrypoint {
						async run(name) {
							return [this.ctx.props.label, await this.env.greeter.greet(name)];
						}
					}
				`,
				"lib/util.js": `export const suffix = "!";`,
			},
			env: { greeter: ctx.exports.Greeter({ props: { greeting: "Hello" } }), hello: 123 },
		}));
		const response = await worker.getEntrypoint().fetch("https://example.com/path");
		return {
			fetch: [response.status, response.headers.get("x-dynamic"), await response.text()],
			rpc: await worker.getEntrypoint("Named", { props: { label: "props" } }).run("Ada"),
		};
	},
	// A dynamic Worker serves a node:http server through cloudflare:node.
	async http(env) {
		const worker = env.LOADER.get("http", () => ({
			compatibilityDate: "2026-09-03",
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "main.js",
			modules: {
				"main.js": `
					import http from "node:http";
					import { httpServerHandler } from "cloudflare:node";
					const server = http.createServer((req, res) => {
						if (req.url === "/kinds") {
							res.writeHead(202);
							res.end(JSON.stringify({
								instances: [req instanceof http.IncomingMessage, res instanceof http.ServerResponse, server instanceof http.Server],
								statusMessage: res.statusMessage,
							}));
							return;
						}
						if (req.url === "/cookies") {
							res.setHeader("set-cookie", ["a=1", "b=2"]);
							res.end("cookies");
							return;
						}
						if (req.method === "POST") {
							const chunks = [];
							req.on("data", (chunk) => chunks.push(chunk));
							req.on("end", () => res.end("echo " + Buffer.concat(chunks).toString()));
							return;
						}
						res.writeHead(201, { "x-node": req.method + " " + req.url });
						res.write("hello ");
						res.end("node");
					});
					server.listen(8080);
					export default httpServerHandler({ port: 8080 });
				`,
			},
		})).getEntrypoint();
		const describe = async (response) => ({
			body: await response.text(),
			cookies: response.headers.getSetCookie(),
			header: response.headers.get("x-node"),
			status: response.status,
		});
		return {
			cookies: await describe(await worker.fetch("https://example.com/cookies")),
			get: await describe(await worker.fetch("https://example.com/hi?x=1")),
			kinds: JSON.parse(await (await worker.fetch("https://example.com/kinds")).text()),
			post: await describe(await worker.fetch("https://example.com/echo", { body: "ping", method: "POST" })),
		};
	},
	// A dynamic Worker runs an Express app that the test bundled and posted.
	async express(env, _ctx, request) {
		const app = await request.text();
		const worker = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "main.js",
			modules: { "main.js": app },
		}).getEntrypoint();
		const describe = async (response) => ({
			body: await response.text(),
			cookies: response.headers.getSetCookie(),
			status: response.status,
			type: response.headers.get("content-type"),
		});
		return {
			cookies: await describe(await worker.fetch("https://example.com/cookies")),
			missing: await describe(await worker.fetch("https://example.com/missing")),
			post: await describe(
				await worker.fetch("https://example.com/echo", {
					body: JSON.stringify({ name: "Ada" }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}),
			),
			user: await describe(await worker.fetch("https://example.com/users/42")),
		};
	},
	async isolation(env) {
		const worker = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `export default {
					inspect(_arg, env) {
						return {
							envKeys: Object.keys(env),
							marker: typeof globalThis.parentMarker,
							secret: process.env.SECRET ?? null,
						};
					},
				};`,
			},
			env: { given: "yes" },
		});
		return worker.getEntrypoint().inspect(null);
	},
	// A dynamic Worker with no outbound tries the network and a host file.
	async sandbox(env, _ctx, request) {
		const path = new URL(request.url).searchParams.get("path");
		const worker = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			globalOutbound: null,
			mainModule: "main.js",
			modules: {
				"main.js": `
					import { createRequire } from "node:module";
					const fs = createRequire(import.meta.url)("fs");
					export default {
						async net() {
							try { await fetch("https://example.com/"); return "reached"; } catch (error) { return error.message; }
						},
						read(path) {
							try { return { content: fs.readFileSync(path, "utf8") }; } catch (error) { return { error: error.code ?? error.message }; }
						},
					};
				`,
			},
		}).getEntrypoint();
		return { net: await worker.net(null), read: await worker.read(path) };
	},
	async filesystem(env) {
		const path = "/tmp/open-orange-isolation.txt";
		const writer = env.LOADER.get("fs-writer", () => filesystemCode).getEntrypoint();
		const reader = env.LOADER.get("fs-reader", () => filesystemCode).getEntrypoint();
		const written = await writer.write(path);
		return { reader: await reader.read(path), writer: written };
	},
	async loopback(env, _ctx, request) {
		const url = new URL(request.url);
		const ports = [Number(url.port), Number(url.searchParams.get("engine"))];
		return {
			blocked: await env.LOADER.load(loopbackCode(null)).getEntrypoint().probe(ports),
			network: await env.LOADER.load(loopbackCode(undefined)).getEntrypoint().probe(ports),
		};
	},
	async outbound(env) {
		const code = (globalOutbound) => ({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `
					import { connect } from "cloudflare:sockets";
					export default {
						async fetch() { return fetch("http://127.0.0.1:9/"); },
						tryConnect() {
							try { connect("127.0.0.1:9"); return "connected"; } catch (error) { return error.message; }
						},
					};
				`,
			},
			...(globalOutbound === undefined ? {} : { globalOutbound }),
		});
		const blocked = env.LOADER.load(code(null)).getEntrypoint();
		return {
			connect: await blocked.tryConnect(null),
			fetch: await settle(blocked.fetch("https://example.com/")),
		};
	},
	async cache(env) {
		let loads = 0;
		const getCode = () => {
			loads += 1;
			return counterCode;
		};
		const first = env.LOADER.get("cache-a", getCode).getEntrypoint();
		const counts = [await first.increment(), await first.increment()];
		counts.push(await env.LOADER.get("cache-a", getCode).getEntrypoint().increment());
		counts.push(await env.LOADER.get("cache-b", getCode).getEntrypoint().increment());
		counts.push(await env.LOADER.get(null, getCode).getEntrypoint().increment());
		return { counts, loads };
	},
	async syntax(env) {
		const worker = env.LOADER.get("syntax", () => ({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: { "main.js": "export default {\n  greet( {\n};" },
		}));
		return settle(worker.getEntrypoint().greet("x"));
	},
	async unsupported(env) {
		const staticImport = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `import "./lib.js";\nexport default { ping() { return "pong"; } };`,
				"lib.js": `import { thing } from "cloudflare:nope";\nexport { thing };`,
			},
		});
		const dynamicImport = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `export default { async load() { await import("cloudflare:nope"); } };`,
			},
		});
		return {
			dynamic: await settle(dynamicImport.getEntrypoint().load(null)),
			static: await settle(staticImport.getEntrypoint().ping(null)),
		};
	},
	async crash(env) {
		const worker = env.LOADER.get("crash", () => counterCode).getEntrypoint();
		await worker.increment();
		const crashed = await settle(worker.crash());
		const reloaded = env.LOADER.get("crash", () => counterCode).getEntrypoint();
		return { afterReload: await reloaded.increment(), crashed };
	},
	async namedOnly(env) {
		const worker = env.LOADER.get("named-only", () => ({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `
					import { WorkerEntrypoint } from "cloudflare:workers";
					export class Named extends WorkerEntrypoint {
						ping() { return "named"; }
					}
				`,
			},
		}));
		return await worker.getEntrypoint("Named").ping();
	},
	async abort(env) {
		const worker = env.LOADER.get("abort", () => counterCode).getEntrypoint();
		await worker.increment();
		const aborted = await settle(worker.abort());
		const reloaded = env.LOADER.get("abort", () => counterCode).getEntrypoint();
		const parent = await settle(Promise.resolve().then(() => abortIsolate("parent")));
		return { afterReload: await reloaded.increment(), aborted, parent };
	},
	async modules(env) {
		const wasm = new Uint8Array([
			0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f,
			0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
			0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
		]);
		const worker = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": {
					js: `
						import text from "./a.txt";
						import json from "./b.json";
						import cjs from "./c.cjs";
						import data from "./d.bin";
						import wasm from "./e.wasm";
						export default {
							async read() {
								const instance = await WebAssembly.instantiate(wasm);
								const computed = await import(["./a", "txt"].join("."));
								return [text, json.value, cjs.greet("Bo"), new TextDecoder().decode(data), instance.exports.add(2, 3), computed.default];
							},
						};
					`,
				},
				"a.txt": { text: "text" },
				"b.json": { json: { value: 42 } },
				"c.cjs": {
					cjs: "const { prefix } = require('./lib/prefix.cjs');\nmodule.exports = { greet: (name) => prefix + name };",
				},
				"lib/prefix.cjs": { cjs: "module.exports = { prefix: 'cjs ' };" },
				"d.bin": { data: new TextEncoder().encode("data") },
				"e.wasm": { wasm },
			},
		});
		return worker.getEntrypoint().read(null);
	},
	async values(env) {
		const worker = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `
					${describeValues.toString()}
					export default {
						echo(value) { return { echo: value, seen: describeValues(value) }; },
					};
				`,
			},
		});
		const bytes = new Uint8Array([1, 2, 250]);
		const value = {
			bytes,
			date: new Date(Date.UTC(2026, 0, 2)),
			error: new TypeError("outer", { cause: new RangeError("inner") }),
			map: new Map([
				["big", 2n ** 70n],
				[7, new Date(0)],
			]),
			missing: undefined,
			nan: Number.NaN,
			negZero: -0,
			sameBytes: bytes,
		};
		value.self = value;
		const { echo, seen } = await worker.getEntrypoint().echo(value);
		return { child: seen, parent: describeValues(echo) };
	},
};

export default {
	async fetch(request, env, ctx) {
		const route = routes[new URL(request.url).pathname.slice(1)];
		if (route === undefined) return new Response("not found", { status: 404 });
		return Response.json(await route(env, ctx, request));
	},
};
