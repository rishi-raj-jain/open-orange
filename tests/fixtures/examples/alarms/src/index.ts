import { DurableObject } from "cloudflare:workers";

interface Env {
	REMINDERS: DurableObjectNamespace<Reminders>;
}

type Reminder = { id: number; text: string; dueAt: number; firedAt: number | null };

const columns = "id, text, due_at AS dueAt, fired_at AS firedAt";

// Each object has one alarm. It always points at the earliest pending reminder.
export class Reminders extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY, text TEXT NOT NULL, due_at INTEGER NOT NULL, fired_at INTEGER)",
		);
	}

	async add(text: string, delaySeconds: number): Promise<Reminder> {
		const dueAt = Date.now() + delaySeconds * 1000;
		const [reminder] = this.ctx.storage.sql
			.exec<Reminder>(
				`INSERT INTO reminders (text, due_at) VALUES (?, ?) RETURNING ${columns}`,
				text,
				dueAt,
			)
			.toArray();
		const alarm = await this.ctx.storage.getAlarm();
		if (alarm === null || dueAt < alarm) await this.ctx.storage.setAlarm(dueAt);
		return reminder;
	}

	list(): Reminder[] {
		return this.ctx.storage.sql.exec<Reminder>(`SELECT ${columns} FROM reminders ORDER BY due_at`).toArray();
	}

	// The runtime calls alarm() at the scheduled time, even if the object slept.
	async alarm(): Promise<void> {
		const now = Date.now();
		const sql = this.ctx.storage.sql;
		sql.exec("UPDATE reminders SET fired_at = ? WHERE fired_at IS NULL AND due_at <= ?", now, now);
		const { next } = sql
			.exec<{ next: number | null }>("SELECT min(due_at) AS next FROM reminders WHERE fired_at IS NULL")
			.one();
		if (next !== null) await this.ctx.storage.setAlarm(next);
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const name = /^\/reminders\/([\w-]+)$/.exec(new URL(request.url).pathname)?.[1];
		if (name === undefined) {
			return new Response("Try /reminders/<list>", { status: 404 });
		}
		const reminders = env.REMINDERS.getByName(name);
		if (request.method !== "POST") {
			return Response.json({ reminders: await reminders.list() });
		}

		const body = await request
			.json<{ text?: unknown; inSeconds?: unknown }>()
			.catch(() => ({}) as { text?: unknown; inSeconds?: unknown });
		if (
			typeof body.text !== "string" ||
			typeof body.inSeconds !== "number" ||
			!(body.inSeconds > 0)
		) {
			return Response.json(
				{ error: "Send JSON like {\"text\":\"stretch\",\"inSeconds\":5}" },
				{ status: 400 },
			);
		}
		return Response.json(await reminders.add(body.text, body.inSeconds), { status: 201 });
	},
} satisfies ExportedHandler<Env>;
