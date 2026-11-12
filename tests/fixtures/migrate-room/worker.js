// A plain Cloudflare Worker. The same file runs on real workerd as the migration source and on
// Orange as the destination.
import { DurableObject } from "cloudflare:workers";

function describeKvValue(value) {
	if (value instanceof Date) return { date: value.toISOString() };
	if (value instanceof Map) return { map: [...value] };
	if (value instanceof Uint8Array) return { bytes: [...value] };
	if (typeof value === "bigint") return { bigint: String(value) };
	return value;
}

export class Room extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		// Runs on every start, as most real objects do. An import must come before it.
		ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, raw BLOB)`);
		ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS messages_body ON messages(body)`);
	}

	async fetch(request) {
		const { pathname, searchParams } = new URL(request.url);
		const sql = this.ctx.storage.sql;
		if (pathname === "/seed") {
			const rows = Number(searchParams.get("rows"));
			const bytes = Number(searchParams.get("bytes") ?? 0);
			for (let index = 0; index < rows; index += 1) {
				sql.exec(`INSERT INTO messages(body, raw) VALUES (?, ?)`, `seed-${index}`, new Uint8Array(bytes).fill(index % 251).buffer);
			}
			await this.ctx.storage.put("date", new Date("2026-01-02T03:04:05.000Z"));
			await this.ctx.storage.put("map", new Map([["a", 1]]));
			await this.ctx.storage.put("bytes", new Uint8Array([1, 2, 3]));
			await this.ctx.storage.put("bigint", 12345678901234567890n);
			this.ctx.storage.kv.put("plain", { nested: [1, "two"] });
			return Response.json({ ok: true });
		}
		if (pathname === "/write") {
			const body = await request.text();
			sql.exec(`INSERT INTO messages(body) VALUES (?)`, body);
			return Response.json({ ok: true });
		}
		if (pathname === "/alarm") {
			await this.ctx.storage.setAlarm(Number(searchParams.get("at")));
			return Response.json({ ok: true });
		}
		if (pathname === "/delete-all") {
			await this.ctx.storage.deleteAll();
			sql.exec(`CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, raw BLOB)`);
			return Response.json({ ok: true });
		}
		if (pathname === "/math-table") {
			// Cloudflare's SQLite has math functions. Orange's does not, and SQLite checks a CHECK
			// constraint's functions when it creates the table.
			sql.exec(`CREATE TABLE IF NOT EXISTS squares(side REAL CHECK (sqrt(side * side) >= 0))`);
			return Response.json({ ok: true });
		}
		if (pathname === "/socket") {
			const [client, server] = Object.values(new WebSocketPair());
			this.ctx.acceptWebSocket(server);
			return new Response(null, { status: 101, webSocket: client });
		}
		if (pathname === "/restart") {
			// Answer first, because abort() fails every event that is still open.
			setTimeout(() => this.ctx.abort("restart"), 50);
			return Response.json({ ok: true });
		}
		const messages = sql.exec(`SELECT id, body, length(raw) AS rawLength, hex(substr(raw, 1, 2)) AS rawStart FROM messages ORDER BY id`).toArray();
		const kv = {};
		for (const [key, value] of await this.ctx.storage.list()) kv[key] = describeKvValue(value);
		return Response.json({
			alarm: await this.ctx.storage.getAlarm(),
			index: sql.exec(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'messages_body'`).toArray().length === 1,
			kv,
			messages,
			name: this.ctx.id.name ?? null,
			nextId: sql.exec(`SELECT seq FROM sqlite_sequence WHERE name = 'messages'`).toArray()[0]?.seq ?? 0,
		});
	}

	countMessages() {
		return this.ctx.storage.sql.exec(`SELECT count(*) AS count FROM messages`).one().count;
	}

	// A hibernatable socket: each message is a row, and the reply is the row count.
	webSocketMessage(socket, message) {
		this.ctx.storage.sql.exec(`INSERT INTO messages(body) VALUES (?)`, String(message));
		socket.send(String(this.countMessages()));
	}

	alarm() {
		this.ctx.storage.sql.exec(`INSERT INTO messages(body) VALUES ('alarm fired')`);
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/new") {
			return new Response(env.ROOMS.newUniqueId().toString());
		}
		const rpc = /^\/rpc\/([^/]+)$/.exec(url.pathname);
		if (rpc !== null) {
			return Response.json(await env.ROOMS.get(env.ROOMS.idFromName(rpc[1])).countMessages());
		}
		const match = /^\/(rooms|ids)\/([^/]+)(\/.*)?$/.exec(url.pathname);
		if (match === null) return new Response("Not Found", { status: 404 });
		const [, kind, target, path = "/"] = match;
		const id = kind === "rooms" ? env.ROOMS.idFromName(target) : env.ROOMS.idFromString(target);
		return await env.ROOMS.get(id).fetch(new Request(new URL(path + url.search, url), request));
	},
};
