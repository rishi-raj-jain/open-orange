// A per-user code runner built on the Cloudflare Sandbox SDK.
// https://developers.cloudflare.com/sandbox/
import { getSandbox, proxyToSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
	Sandbox: DurableObjectNamespace<Sandbox>;
}

type RunRequest = { command?: unknown; cwd?: string; env?: Record<string, string>; timeout?: number };

// Preview URLs look like http://<port>-<sandbox id>.<host>, so ids must be DNS labels.
const userId = /^[a-z0-9][a-z0-9-]{0,30}$/;
const route = /^\/users\/([^/]+)(\/.*)?$/;

function error(status: number, message: string): Response {
	return Response.json({ error: message }, { status });
}

export default {
	async fetch(request, env): Promise<Response> {
		// Requests to a preview URL go to the exposed port in the sandbox.
		const preview = await proxyToSandbox(request, env);
		if (preview) return preview;

		const url = new URL(request.url);
		const match = route.exec(url.pathname);
		if (match === null) return error(404, "Try /users/<id>/run");
		const [, user = "", rest = "/"] = match;
		if (!userId.test(user)) return error(400, "User ids are lowercase letters, digits, and dashes");

		// One sandbox per user. The same id always reaches the same sandbox.
		const sandbox = getSandbox(env.Sandbox, user);
		const method = request.method;

		try {
			if (rest === "/" && method === "DELETE") {
				await sandbox.destroy();
				return new Response(null, { status: 204 });
			}

			if (rest === "/run" && method === "POST") {
				const body = (await request.json().catch(() => ({}))) as RunRequest;
				if (typeof body.command !== "string") return error(400, 'Send JSON like {"command":"echo hi"}');
				const { exitCode, stderr, stdout, success } = await sandbox.exec(body.command, {
					cwd: body.cwd,
					env: body.env,
					timeout: body.timeout,
				});
				// A failing command is a normal result, not an HTTP error.
				return Response.json({ exitCode, stderr, stdout, success });
			}

			if (rest === "/stream" && method === "POST") {
				const command = await request.text();
				if (command === "") return error(400, "Send the command as the request body");
				// execStream returns Server-Sent Events: start, stdout, stderr, complete.
				return new Response(await sandbox.execStream(command), {
					headers: { "cache-control": "no-store", "content-type": "text/event-stream" },
				});
			}

			if (rest === "/files" && method === "GET") {
				const { files } = await sandbox.listFiles("/workspace", { recursive: true });
				return Response.json(
					files.filter((file) => file.type === "file").map(({ relativePath, size }) => ({ path: relativePath, size })),
				);
			}

			if (rest.startsWith("/files/")) {
				const path = `/workspace/${rest.slice("/files/".length)}`;
				if (path.split("/").includes("..")) return error(400, "Paths cannot contain ..");
				if (method === "PUT") {
					await sandbox.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
					await sandbox.writeFile(path, await request.text());
					return new Response(null, { status: 204 });
				}
				if (method === "GET") {
					if (!(await sandbox.exists(path)).exists) return error(404, `No file ${path}`);
					return new Response((await sandbox.readFile(path)).content);
				}
				if (method === "DELETE") {
					if (!(await sandbox.exists(path)).exists) return error(404, `No file ${path}`);
					await sandbox.deleteFile(path);
					return new Response(null, { status: 204 });
				}
			}

			if (rest === "/git" && method === "POST") {
				const git = await sandbox.exec("git --version");
				if (!git.success) return error(503, "git is not installed in this sandbox, so the checkout is skipped");
				// Clone a URL when one is given. Otherwise make a tiny repository in the
				// sandbox and clone that, so the route works without network access.
				let repoUrl = url.searchParams.get("url");
				if (repoUrl === null) {
					const made = await sandbox.exec(
						"rm -rf origin && mkdir origin && cd origin && git init -q && echo '# demo' > README.md" +
							" && git add README.md && git -c user.name=demo -c user.email=demo@example.com commit -qm init && pwd",
					);
					if (!made.success) return error(500, `Could not create the demo repository: ${made.stderr}`);
					repoUrl = `file://${made.stdout.trim()}`;
				}
				await sandbox.exec("rm -rf checkout");
				// A relative target works on every provider, including local.
				await sandbox.gitCheckout(repoUrl, { targetDir: "checkout" });
				const { files } = await sandbox.listFiles("/workspace/checkout");
				return Response.json({ files: files.map(({ name }) => name), repoUrl });
			}

			if (rest === "/server" && method === "POST") {
				const port = Number(url.searchParams.get("port") ?? 8080);
				if (!Number.isInteger(port) || port < 1024 || port > 65535) return error(400, "Pick a port from 1024 to 65535");
				await sandbox.writeFile(
					"/workspace/server.mjs",
					`import { createServer } from "node:http";
createServer((req, res) => res.end("hello from the sandbox " + req.url)).listen(${port}, "127.0.0.1");
console.log("listening on ${port}");
`,
				);
				const running = await sandbox.getProcess("web");
				if (running !== null && running.status === "running") return error(409, "The server is already running");
				const server = await sandbox.startProcess("node server.mjs", { processId: "web" });
				try {
					await server.waitForPort(port, { timeout: 10_000 });
				} catch (cause) {
					const { stderr } = await sandbox.getProcessLogs("web");
					return error(504, `The server did not open port ${port}: ${stderr || String(cause)}`);
				}
				// Preview hosts are subdomains, so an IP address origin uses localhost,
				// which most systems resolve to 127.0.0.1.
				const hostname = /^[\d.]+$/.test(url.hostname) ? `localhost${url.port === "" ? "" : `:${url.port}`}` : url.host;
				const { url: previewUrl } = await sandbox.exposePort(port, { hostname });
				return Response.json({ previewUrl, processId: server.id }, { status: 201 });
			}

			if (rest === "/processes" && method === "GET") {
				const processes = await sandbox.listProcesses();
				return Response.json(processes.map(({ command, exitCode, id, status }) => ({ command, exitCode, id, status })));
			}

			const processRoute = /^\/processes\/([^/]+)(\/logs)?$/.exec(rest);
			if (processRoute !== null) {
				const [, id = "", logs] = processRoute;
				if ((await sandbox.getProcess(id)) === null) return error(404, `No process ${id}`);
				if (logs !== undefined && method === "GET") return Response.json(await sandbox.getProcessLogs(id));
				if (logs === undefined && method === "DELETE") {
					await sandbox.killProcess(id);
					const process = await sandbox.getProcess(id);
					return Response.json({ id, status: process?.status });
				}
			}

			return error(404, `No route ${method} ${url.pathname}`);
		} catch (cause) {
			// Provider errors, such as a missing API key, name the fix in the message.
			return error(500, cause instanceof Error ? cause.message : String(cause));
		}
	},
} satisfies ExportedHandler<Env>;
