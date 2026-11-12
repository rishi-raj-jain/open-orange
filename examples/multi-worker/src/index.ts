import type Auth from "../auth/src/index.js";
import type { Admin, Session } from "../auth/src/index.js";

interface Env {
	AUTH: Service<Auth>;
	ADMIN: Service<Admin>;
	SESSIONS: DurableObjectNamespace<Session>;
	EMAILS: Queue<{ to: string; subject: string }>;
	SIGNUPS: Workflow<{ user: string; email: string }>;
	WORKERS: DispatchNamespace;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// The gateway owns no state. Every route reaches another Worker of the session.
export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const [, route = "", name = "", ...rest] = url.pathname.split("/");

		switch (route) {
			case "health":
				// fetch() through a service binding to auth's default entrypoint.
				return env.AUTH.fetch("http://auth/health");
			case "login":
				try {
					// JS RPC to auth's default entrypoint.
					return Response.json(await env.AUTH.login(name));
				} catch (error) {
					// auth throws a RangeError. It reaches this Worker with its message.
					return Response.json({ error: errorMessage(error) }, { status: 400 });
				}
			case "sessions":
				if (request.method === "DELETE") {
					// RPC to the named entrypoint Admin.
					return Response.json(await env.ADMIN.revoke(name));
				}
				// auth's Durable Object, called directly through script_name.
				return Response.json(await env.SESSIONS.getByName(name).read());
			case "stats":
				return Response.json(await env.ADMIN.stats());
			case "emails": {
				const body = (await request.json().catch(() => ({}))) as { to?: unknown };
				if (typeof body.to !== "string" || !body.to.includes("@")) {
					return Response.json({ error: 'Send JSON like {"to":"ada@example.com"}' }, { status: 400 });
				}
				// jobs consumes the queue. This Worker only produces to it.
				await env.EMAILS.send({ subject: "Hello", to: body.to });
				return Response.json({ queued: body.to }, { status: 202 });
			}
			case "signups":
				return signups(request, env, name);
			case "workers": {
				// A dispatch namespace call. The user Workers are the session's Workers.
				try {
					return await env.WORKERS.get(name).fetch(new URL(`/${rest.join("/")}`, request.url), request);
				} catch (error) {
					// An unknown Worker throws "Worker not found.", like Cloudflare.
					return Response.json({ error: errorMessage(error) }, { status: 404 });
				}
			}
			default:
				return new Response(
					"Try /health, /login/<user>, /sessions/<user>, /stats, /emails, /signups/<user>, or /workers/<name>/<path>",
					{ status: 404 },
				);
		}
	},
} satisfies ExportedHandler<Env>;

async function signups(request: Request, env: Env, user: string): Promise<Response> {
	if (request.method === "POST") {
		const body = (await request.json().catch(() => ({}))) as { email?: unknown };
		if (!/^[a-z]+$/.test(user) || typeof body.email !== "string") {
			return Response.json({ error: 'POST /signups/<lowercase user> with {"email":"..."}' }, { status: 400 });
		}
		try {
			// The Workflow class lives in jobs. script_name runs the instance there.
			await env.SIGNUPS.create({ id: user, params: { email: body.email, user } });
		} catch (error) {
			// One instance per user. A second signup with the same id fails.
			return Response.json({ error: errorMessage(error) }, { status: 409 });
		}
		return Response.json({ id: user }, { status: 201 });
	}
	let instance: WorkflowInstance;
	try {
		instance = await env.SIGNUPS.get(user);
	} catch {
		return Response.json({ error: `No signup for ${user}` }, { status: 404 });
	}
	const { output, status } = await instance.status();
	return Response.json({ output, status });
}
