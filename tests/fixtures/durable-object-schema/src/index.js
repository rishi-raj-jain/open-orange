import { DurableObject } from "cloudflare:workers";

function attempt(run) {
	try {
		return run();
	} catch (error) {
		return { error: error.message };
	}
}

export class Database extends DurableObject {
	// Lists the tables and reads each one, as starbasedb's /export/dump does.
	async dump(useKv) {
		const sql = this.ctx.storage.sql;
		if (useKv) await this.ctx.storage.put("visits", 1);
		sql.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)");
		sql.exec("INSERT INTO users (name) VALUES ('ada')");
		const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((row) => row.name);
		const rows = {};
		for (const table of tables) rows[table] = attempt(() => sql.exec(`SELECT * FROM "${table}"`).toArray().length);
		const tableList = [...sql.exec("PRAGMA table_list").toArray()]
			.map((row) => row.name)
			.filter((name) => !name.startsWith("sqlite_"))
			.sort();
		return { rows, tableList };
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const kv = url.searchParams.get("kv") === "1";
		return Response.json(await env.DB.getByName(url.searchParams.get("name")).dump(kv));
	},
};
