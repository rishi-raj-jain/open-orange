import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { glob, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";

import { isRecord } from "../unknown-values.js";

const cliEntrypoint = fileURLToPath(new URL("../bin.ts", import.meta.url));
const configPath = fileURLToPath(
	new URL("./fixtures/worker-loader/wrangler.jsonc", import.meta.url),
);

const fixtureRoot = dirname(configPath);

interface EngineStamp {
	endpoint: string;
	pid: number;
}

async function readEngineStamps(): Promise<EngineStamp[]> {
	const stamps: EngineStamp[] = [];
	for await (const path of glob(".open-orange/rivetkit/*/.rivetkit/var/engine/runtime.json", {
		cwd: fixtureRoot,
	})) {
		try {
			const stamp: unknown = JSON.parse(await readFile(join(fixtureRoot, path), "utf8"));
			if (isRecord(stamp) && typeof stamp.endpoint === "string" && typeof stamp.pid === "number") {
				stamps.push({ endpoint: stamp.endpoint, pid: stamp.pid });
			}
		} catch {
			continue;
		}
	}
	return stamps;
}

function waitForReady(child: ChildProcess): Promise<number> {
	return new Promise((resolveReady, rejectReady) => {
		let output = "";
		const timeout = setTimeout(() => {
			rejectReady(new Error(`orange dev readiness timed out: ${output}`));
		}, 30_000);
		const onData = (chunk: unknown): void => {
			output += String(chunk);
			const match = /Local\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
			if (match?.[1] !== undefined) {
				clearTimeout(timeout);
				resolveReady(Number(match[1]));
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			rejectReady(new Error(`orange dev exited before readiness (code ${code}): ${output}`));
		});
	});
}

function stop(child: ChildProcess): Promise<void> {
	return new Promise((resolveStop) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolveStop();
			return;
		}
		const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveStop();
		});
		child.kill("SIGINT");
	});
}

// Bundles the Express fixture app into one ES module. Express requires Node.js
// built-ins, so each require reads a namespace that the module imports, and
// node:http resolves to the runtime's module as in any dynamic Worker.
async function bundleExpressApp(): Promise<string> {
	const builtins = new Set<string>();
	const builtinRequires: Plugin = {
		name: "builtin-requires",
		setup(pluginBuild) {
			pluginBuild.onResolve({ filter: /.*/ }, (args) => {
				const name = args.path.replace(/^node:/, "");
				if (args.kind !== "require-call" || !builtinModules.includes(name)) return undefined;
				builtins.add(name);
				return { namespace: "builtin", path: name };
			});
			pluginBuild.onLoad({ filter: /.*/, namespace: "builtin" }, (args) => ({
				contents: `module.exports = globalThis.__expressBuiltins[${JSON.stringify(args.path)}];`,
				loader: "js",
			}));
		},
	};
	const result = await build({
		bundle: true,
		entryPoints: [join(fixtureRoot, "express-app.js")],
		external: ["cloudflare:*"],
		format: "esm",
		logLevel: "silent",
		platform: "node",
		plugins: [builtinRequires],
		write: false,
	});
	const names = [...builtins];
	const imports = names.map((name, i) => `import * as builtin${i} from "node:${name}";`);
	const table = names.map((name, i) => `${JSON.stringify(name)}: builtin${i}.default ?? builtin${i}`);
	return `${imports.join("\n")}\nglobalThis.__expressBuiltins = { ${table.join(", ")} };\n${result.outputFiles[0]?.text ?? ""}`;
}

test("loads dynamic Workers with workerd Worker Loader semantics in agentOS VMs", async () => {
	const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", NO_COLOR: "1" };
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			cliEntrypoint,
			"dev",
			"--config",
			configPath,
			"--port",
			"0",
			"--ip",
			"127.0.0.1",
			"--show-interactive-dev-session=false",
		],
		{
			env,
			stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	try {
		const port = await waitForReady(child);
		const get = async (route: string): Promise<unknown> => {
			const response = await fetch(`http://127.0.0.1:${port}/${route}`);
			assert.equal(response.status, 200, await response.clone().text());
			return response.json();
		};

		// When the parent calls fetch() and RPC on a loaded Worker, it gets the
		// dynamic Worker's responses, with env and props capabilities working.
		// The dynamic Worker's stdout reaches the log and leaves RPC intact.
		assert.deepEqual(await get("basic"), {
			fetch: [200, "yes", "/path 123!"],
			rpc: ["props", "Hello, Ada!"],
		});
		assert.match(output, /dynamic Worker stdout/);

		// A dynamic Worker's node:http server answers fetches through
		// cloudflare:node with its status, headers, cookies, and streamed body.
		// Its requests, responses, and server are instances of the node:http
		// classes, and a response gets the standard reason phrase.
		assert.deepEqual(await get("http"), {
			cookies: { body: "cookies", cookies: ["a=1", "b=2"], header: null, status: 200 },
			get: { body: "hello node", cookies: [], header: "GET /hi?x=1", status: 201 },
			kinds: { instances: [true, true, true], statusMessage: "Accepted" },
			post: { body: "echo ping", cookies: [], header: null, status: 200 },
		});

		// An Express app in a dynamic Worker serves params, JSON, status codes,
		// repeated cookies, and parsed JSON bodies.
		const expressResponse = await fetch(`http://127.0.0.1:${port}/express`, {
			body: await bundleExpressApp(),
			method: "POST",
		});
		assert.equal(expressResponse.status, 200, await expressResponse.clone().text());
		assert.deepEqual(await expressResponse.json(), {
			cookies: {
				body: "cookies",
				cookies: ["a=1; Path=/", "b=2; Path=/"],
				status: 200,
				type: "text/html; charset=utf-8",
			},
			missing: {
				body: '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET /missing</pre>\n</body>\n</html>\n',
				cookies: [],
				status: 404,
				type: "text/html; charset=utf-8",
			},
			post: { body: "hello Ada", cookies: [], status: 201, type: "text/html; charset=utf-8" },
			user: { body: '{"id":"42"}', cookies: [], status: 200, type: "application/json; charset=utf-8" },
		});

		// A dynamic Worker sees only the env it was given, not the parent's
		// globals, vars, or process.env.
		assert.deepEqual(await get("isolation"), {
			envKeys: ["given"],
			marker: "undefined",
			secret: null,
		});

		// With `globalOutbound: null`, fetch() rejects and connect() throws with
		// workerd's message.
		const blockedMessage =
			"This worker is not permitted to access the internet via global functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside world.";
		assert.deepEqual(await get("outbound"), {
			connect: blockedMessage,
			fetch: { error: { message: blockedMessage, name: "Error" } },
		});

		// Values that JSON cannot carry cross to a dynamic Worker RPC method and
		// back intact, including types, shared references, and cycles.
		const described = {
			bytes: [1, 2, 250],
			cycle: true,
			date: "2026-01-02T00:00:00.000Z",
			edges: [true, true, true],
			error: [true, "outer", true, true, "inner"],
			map: [
				["big", "1180591620717411303424n"],
				[7, "1970-01-01T00:00:00.000Z"],
			],
			sharedBytes: true,
		};
		assert.deepEqual(await get("values"), { child: described, parent: described });

		// The same name reuses the loaded Worker and its module state; another
		// name or no name loads a fresh Worker and calls the code callback.
		assert.deepEqual(await get("cache"), { counts: [1, 2, 3, 1, 1], loads: 3 });

		// A syntax error in a module rejects the call with V8's SyntaxError.
		assert.deepEqual(await get("syntax"), {
			error: { message: "Unexpected token ';'", name: "SyntaxError" },
		});

		// An unsupported `cloudflare:*` import rejects with workerd's error,
		// at load for a static import and at the call for a dynamic import.
		const noSuchModule = {
			error: { message: 'No such module "cloudflare:nope".\n  imported from "lib.js"', name: "Error" },
		};
		assert.deepEqual(await get("unsupported"), {
			dynamic: {
				error: { message: 'No such module "cloudflare:nope".\n  imported from "main.js"', name: "Error" },
			},
			static: noSuchModule,
		});

		// When a dynamic Worker process dies, its call rejects, the parent keeps
		// serving, and the next get() with that name loads a fresh Worker.
		const crash = await get("crash");
		assert.ok(
			isRecord(crash) &&
				isRecord(crash.crashed) &&
				isRecord(crash.crashed.error) &&
				typeof crash.crashed.error.message === "string",
			JSON.stringify(crash),
		);
		assert.match(crash.crashed.error.message, /exited unexpectedly \(code 137\)/);
		assert.equal(crash.afterReload, 1);

		// A dynamic Worker without a default export serves its named entrypoints.
		assert.equal(await get("namedOnly"), "named");

		// abortIsolate() in a dynamic Worker fails its call with workerd's internal error, which
		// does not show the reason, and the next get() with that name loads a fresh Worker. The
		// parent Worker cannot abort its own isolate.
		const abort = await get("abort");
		assert.ok(isRecord(abort) && isRecord(abort.aborted) && isRecord(abort.aborted.error), JSON.stringify(abort));
		assert.match(String(abort.aborted.error.message), /^internal error; reference = [0-9a-f-]+$/);
		assert.equal(abort.afterReload, 1);
		assert.ok(isRecord(abort.parent) && isRecord(abort.parent.error), JSON.stringify(abort));
		assert.match(String(abort.parent.error.message), /only in a dynamic Worker/);

		// Text, JSON, CommonJS, data, and Wasm modules import like in workerd,
		// and so does a specifier computed at runtime.
		assert.deepEqual(await get("modules"), ["text", 42, "cjs Bo", "data", 5, "text"]);

		// Two dynamic Workers run in separate VMs, so a file that one writes is
		// not visible to the other.
		assert.deepEqual(await get("filesystem"), {
			reader: { error: "ENOENT" },
			writer: "dynamic secret",
		});

		// A dynamic Worker cannot reach host loopback ports, such as the parent's
		// own `orange dev` port or the Rivet Engine port, by fetch() or node:net,
		// with the default `globalOutbound` or with `null`.
		const engine = (await readEngineStamps())[0];
		assert.ok(engine !== undefined, "orange dev started no Rivet Engine");
		const enginePort = Number(new URL(engine.endpoint).port);
		const loopback = await get(`loopback?engine=${enginePort}`);
		assert.ok(isRecord(loopback), JSON.stringify(loopback));
		for (const outbound of ["blocked", "network"]) {
			const probes: unknown = loopback[outbound];
			for (const target of [String(port), String(enginePort)]) {
				const probe: unknown = isRecord(probes) ? probes[target] : undefined;
				assert.ok(isRecord(probe), `no ${outbound} probe for port ${target}`);
				assert.equal(probe.fetch, "failed", `${outbound} fetch reached port ${target}`);
				assert.notEqual(probe.net, "connected", `${outbound} node:net reached port ${target}`);
			}
		}

		// A dynamic Worker in a VM gets the blocked error from fetch() and
		// cannot read a file on the host, even through the real node:fs.
		const hostFile = join(await mkdtemp(join(tmpdir(), "orange-host-")), "secret.txt");
		await writeFile(hostFile, "host secret");
		const sandbox = await get(`sandbox?path=${encodeURIComponent(hostFile)}`);
		assert.ok(isRecord(sandbox) && isRecord(sandbox.read), JSON.stringify(sandbox));
		assert.equal(sandbox.net, blockedMessage);
		assert.equal(sandbox.read.content, undefined);
		assert.equal(sandbox.read.error, "ENOENT");
		await rm(dirname(hostFile), { force: true, recursive: true });
	} finally {
		await stop(child);
	}
});
