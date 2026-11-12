import { DurableObject } from "cloudflare:workers";

interface Request_ {
	sql: string;
	params?: unknown[];
}

function failure(error: unknown): Response {
	return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
}

export class Sql extends DurableObject {
	override async fetch(request: Request): Promise<Response> {
		const { sql, params = [] } = (await request.json()) as Request_;
		try {
			// The first KV write creates the private _cf_KV table.
			await this.ctx.storage.put("seen", true);
			const cursor = this.ctx.storage.sql.exec(sql, ...(params as never[]));
			const rows = cursor.toArray();
			return Response.json({
				rows,
				columnNames: cursor.columnNames,
				rowsRead: cursor.rowsRead,
				rowsWritten: cursor.rowsWritten,
				databaseSize: this.ctx.storage.sql.databaseSize,
			});
		} catch (error) {
			return failure(error);
		}
	}
}

export default {
	async fetch(request: Request, env: { SQL: DurableObjectNamespace; DB: D1Database }): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/do/")) {
			return env.SQL.get(env.SQL.idFromName(url.pathname.slice(4))).fetch(request);
		}
		if (url.pathname === "/d1") {
			const { sql, params = [] } = (await request.json()) as Request_;
			try {
				const result = await env.DB.prepare(sql)
					.bind(...params)
					.all();
				return Response.json(result);
			} catch (error) {
				return failure(error);
			}
		}
		if (url.pathname === "/d1/batch") {
			const statements = (await request.json()) as string[];
			try {
				return Response.json(await env.DB.batch(statements.map((sql) => env.DB.prepare(sql))));
			} catch (error) {
				return failure(error);
			}
		}
		return new Response("not found", { status: 404 });
	},
};
