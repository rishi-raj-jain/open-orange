import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

interface Env {
	SESSIONS: DurableObjectNamespace<Session>;
	USERS: KVNamespace;
}

// One Session object per user. auth owns the class; gateway uses it too.
export class Session extends DurableObject<Env> {
	async login(): Promise<number> {
		const logins = ((await this.ctx.storage.get<number>("logins")) ?? 0) + 1;
		await this.ctx.storage.put("logins", logins);
		return logins;
	}

	async read(): Promise<{ active: boolean; logins: number }> {
		const logins = (await this.ctx.storage.get<number>("logins")) ?? 0;
		return { active: logins > 0, logins };
	}

	async revoke(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}

function checkUser(user: string): void {
	if (!/^[a-z]+$/.test(user)) {
		throw new RangeError("user must be lowercase letters");
	}
}

// The default entrypoint: plain fetch() plus RPC methods.
export default class Auth extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/health") return new Response("auth is up");
		return new Response(`auth has no route ${pathname}`, { status: 404 });
	}

	async login(user: string): Promise<{ logins: number; user: string }> {
		checkUser(user);
		const logins = await this.env.SESSIONS.getByName(user).login();
		await this.env.USERS.put(user, String(Date.now()));
		return { logins, user };
	}
}

// A named entrypoint. Bind it with "entrypoint": "Admin".
export class Admin extends WorkerEntrypoint<Env> {
	async revoke(user: string): Promise<{ revoked: string }> {
		checkUser(user);
		await this.env.SESSIONS.getByName(user).revoke();
		await this.env.USERS.delete(user);
		return { revoked: user };
	}

	async stats(): Promise<{ users: string[] }> {
		const { keys } = await this.env.USERS.list();
		return { users: keys.map(({ name }) => name) };
	}
}
