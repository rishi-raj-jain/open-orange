// A per-name sandbox built on the @cloudflare/sandbox 1.x API: the Durable
// Object starts its own Container and uses `Files` for file operations.
// Adapted from https://github.com/cloudflare/sandbox-sdk/tree/main/examples/minimal
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

interface Env {
	SANDBOX: DurableObjectNamespace<Sandbox>;
}

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const sandboxName = /^[a-z0-9][a-z0-9-]{0,62}$/;
const workspace = "/workspace";

export class Sandbox extends DurableObject<Env> {
	async writeFile(path: string, contents: ReadableStream<Uint8Array>): Promise<void> {
		await new Files(this.ensureRunning()).writeFile(path, contents);
	}

	async readFile(path: string): Promise<Response> {
		return new Files(this.ensureRunning()).readFile(path);
	}

	async exec(argv: string[]): Promise<CommandResult> {
		const process = await this.ensureRunning().exec(argv, { cwd: workspace });
		const output = await process.output();
		const decoder = new TextDecoder();
		return { exitCode: output.exitCode, stderr: decoder.decode(output.stderr), stdout: decoder.decode(output.stdout) };
	}

	async destroy(): Promise<void> {
		const container = this.requireContainer();
		if (container.running) await container.destroy();
	}

	private ensureRunning(): Container {
		const container = this.requireContainer();
		if (!container.running) container.start({ enableInternet: false, instance: "lite" });
		return container;
	}

	private requireContainer(): Container {
		const container = this.ctx.container;
		if (container === undefined) throw new Error("The container binding is not configured");
		return container;
	}
}

// Files enforces no path policy, so the Worker keeps paths inside /workspace.
function workspacePath(routePath: string): string | undefined {
	const segments = decodeURIComponent(routePath).split("/").slice(1);
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
	return `${workspace}/${segments.join("/")}`;
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const match = /^\/sandboxes\/([^/]+)(\/exec|\/files(\/.+))?$/.exec(url.pathname);
		if (match === null) return new Response("Not found", { status: 404 });
		const name = match[1] ?? "";
		if (!sandboxName.test(name)) return new Response("Invalid sandbox name", { status: 400 });
		const sandbox = env.SANDBOX.getByName(name);
		const filePath = match[3] === undefined ? undefined : workspacePath(match[3]);
		if (match[3] !== undefined && filePath === undefined) return new Response("Invalid file path", { status: 400 });
		try {
			if (match[2] === "/exec" && request.method === "POST") {
				const body = (await request.json()) as { argv?: unknown };
				if (!Array.isArray(body.argv) || body.argv.length === 0 || !body.argv.every((part) => typeof part === "string")) {
					return new Response('Body must be JSON such as {"argv": ["ls", "-la"]}', { status: 400 });
				}
				return Response.json(await sandbox.exec(body.argv));
			}
			if (filePath !== undefined && request.method === "PUT") {
				if (request.body === null) return new Response("Request body is required", { status: 400 });
				await sandbox.writeFile(filePath, request.body);
				return new Response(null, { status: 204 });
			}
			if (filePath !== undefined && request.method === "GET") return await sandbox.readFile(filePath);
			if (match[2] === undefined && request.method === "DELETE") {
				await sandbox.destroy();
				return new Response(null, { status: 204 });
			}
			return new Response("Method not allowed", { status: 405 });
		} catch (cause) {
			// A file error from the Durable Object keeps its name and code across RPC.
			if (SandboxFileError.is(cause) && cause.code === "ENOENT") return new Response("No such file or directory", { status: 404 });
			return new Response("Sandbox request failed", { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
