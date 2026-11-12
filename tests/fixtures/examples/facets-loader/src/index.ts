import { DurableObject } from "cloudflare:workers";

interface Env {
	WORKSPACES: DurableObjectNamespace<Workspace>;
	LOADER: WorkerLoader;
}

type Note = { id: number; text: string };

// One user's notes. A facet class needs no binding and no migration: the
// parent creates it with ctx.facets.get(), and it gets its own SQLite database.
export class Notes extends DurableObject {
	setup(): void {
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
	}

	add(text: string): Note {
		this.setup();
		const { id, text: stored } = this.ctx.storage.sql
			.exec<Note>("INSERT INTO notes (text) VALUES (?) RETURNING id, text", text)
			.one();
		// SQL rows are cursor objects. Copy them into plain objects before RPC returns them.
		return { id, text: stored };
	}

	list(): { notes: Note[]; version: number } {
		this.setup();
		const rows = this.ctx.storage.sql.exec<Note>("SELECT id, text FROM notes ORDER BY id").toArray();
		return { notes: rows.map(({ id, text }) => ({ id, text })), version: 1 };
	}

	// Stays in flight until the parent aborts or deletes the facet.
	wait(): Promise<never> {
		return new Promise(() => {});
	}
}

// New code for the same data. It reads the table that Notes wrote.
export class NotesV2 extends Notes {
	override add(text: string): Note {
		return super.add(text.trim());
	}

	override list(): { notes: Note[]; version: number } {
		return { ...super.list(), version: 2 };
	}
}

const classes = { Notes, NotesV2 };
type ClassName = keyof typeof classes;

async function errorMessage(promise: Promise<unknown>): Promise<string | null> {
	try {
		await promise;
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

// A workspace, like an agent, owns one facet per user.
export class Workspace extends DurableObject<Env> {
	className(user: string): ClassName {
		const row = this.ctx.storage.sql.exec<{ name: ClassName }>("SELECT name FROM classes WHERE user = ?", user).toArray()[0];
		return row?.name ?? "Notes";
	}

	facet(user: string) {
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS classes (user TEXT PRIMARY KEY, name TEXT NOT NULL)");
		// The callback runs only when the facet is not running yet.
		return this.ctx.facets.get<Notes>(user, () => ({ class: this.ctx.exports[this.className(user)] }));
	}

	// RPC results carry a disposer. Copy the fields so the result can be returned again.
	async add(user: string, text: string): Promise<Note> {
		const { id, text: stored } = await this.facet(user).add(text);
		return { id, text: stored };
	}

	async list(user: string): Promise<{ notes: Note[]; version: number }> {
		const { notes, version } = await this.facet(user).list();
		return { notes: notes.map(({ id, text }) => ({ id, text })), version };
	}

	// Swap the user's facet to NotesV2. abort() stops the running facet, so the
	// next get() runs the callback again and loads the new class. Storage stays.
	async upgrade(user: string) {
		const old = this.facet(user);
		const inFlight = errorMessage(old.wait());
		await old.list();
		this.ctx.storage.sql.exec("INSERT OR REPLACE INTO classes (user, name) VALUES (?, 'NotesV2')", user);
		this.ctx.facets.abort(user, new Error("upgrading to NotesV2"));
		return { inFlightError: await inFlight, oldStubError: await errorMessage(old.list()), ...(await this.list(user)) };
	}

	// delete() aborts the facet and erases its database.
	async remove(user: string) {
		const old = this.facet(user);
		const inFlight = errorMessage(old.wait());
		await old.list();
		this.ctx.facets.delete(user);
		this.ctx.storage.sql.exec("DELETE FROM classes WHERE user = ?", user);
		return { inFlightError: await inFlight };
	}
}

// User code gets the notes as input. It must export default { run(notes) }.
async function runPlugin(env: Env, code: string, notes: Note[]): Promise<Response> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
	// Same code, same id: the loader reuses the isolate instead of loading again.
	const id = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const worker = env.LOADER.get(id, () => ({
		compatibilityDate: "2026-09-03",
		mainModule: "plugin.js",
		modules: { "plugin.js": code },
		// No network: fetch() and connect() in user code throw.
		globalOutbound: null,
		env: {},
	}));
	try {
		const entrypoint = worker.getEntrypoint() as unknown as { run(notes: Note[]): Promise<unknown> };
		return Response.json({ result: await entrypoint.run(notes) });
	} catch (error) {
		// Syntax errors, thrown errors, and blocked fetches all land here.
		const { message, name } = error instanceof Error ? error : new Error(String(error));
		return Response.json({ error: { message, name } }, { status: 422 });
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const match = /^\/workspaces\/([^/]+)\/users\/([a-z]+)(?:\/(notes|upgrade|run))?$/.exec(url.pathname);
		if (match === null) {
			return new Response("Try /workspaces/<name>/users/<user>/notes, /upgrade, or /run", { status: 404 });
		}
		const [, workspaceName = "", user = "", action] = match;
		const workspace = env.WORKSPACES.getByName(workspaceName);

		switch (`${request.method} ${action ?? ""}`) {
			case "GET notes":
				return Response.json(await workspace.list(user));
			case "POST notes": {
				const text = await request.text();
				if (text.trim() === "") return Response.json({ error: "Send the note text as the body" }, { status: 400 });
				return Response.json(await workspace.add(user, text), { status: 201 });
			}
			case "POST upgrade":
				return Response.json(await workspace.upgrade(user));
			case "DELETE ":
				return Response.json(await workspace.remove(user));
			case "POST run": {
				const { notes } = await workspace.list(user);
				return runPlugin(env, await request.text(), notes);
			}
			default:
				return new Response("Method not allowed", { status: 405 });
		}
	},
} satisfies ExportedHandler<Env>;
