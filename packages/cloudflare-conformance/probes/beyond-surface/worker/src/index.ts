import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableObject } from "cloudflare:workers";

export class Surface extends DurableObject {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sql = this.ctx.storage.sql;
		try {
			switch (url.pathname) {
				case "/blob": {
					sql.exec("CREATE TABLE IF NOT EXISTS blobs (body BLOB)");
					const bytes = new Uint8Array(Number(url.searchParams.get("bytes"))).fill(1);
					sql.exec("INSERT INTO blobs VALUES (?)", bytes);
					return Response.json(sql.exec("SELECT length(body) AS size FROM blobs ORDER BY rowid DESC LIMIT 1").one());
				}
				case "/long-statement": {
					const items = Array.from({ length: Number(url.searchParams.get("items")) }, (_, i) => i).join(",");
					return Response.json({ length: items.length, ...sql.exec(`SELECT count(*) AS n FROM json_each('[${items}]')`).one() });
				}
				case "/params": {
					const count = Number(url.searchParams.get("count"));
					const marks = Array.from({ length: count }, () => "?").join(",");
					const values = Array.from({ length: count }, (_, i) => i);
					return Response.json({ columns: sql.exec(`SELECT ${marks}`, ...values).columnNames.length });
				}
				case "/columns": {
					const count = Number(url.searchParams.get("count"));
					const columns = Array.from({ length: count }, (_, i) => `c${i} INTEGER`).join(",");
					sql.exec(`CREATE TABLE IF NOT EXISTS wide (${columns})`);
					return Response.json({ columns: sql.exec("SELECT * FROM wide").columnNames.length });
				}
				case "/kv": {
					const bytes = new Uint8Array(Number(url.searchParams.get("bytes"))).fill(2);
					await this.ctx.storage.put("large", bytes);
					const stored = (await this.ctx.storage.get("large")) as Uint8Array;
					return Response.json({ size: stored.length });
				}
				default:
					return new Response("not found", { status: 404 });
			}
		} catch (error) {
			return Response.json({ error: error instanceof Error ? error.message : String(error) });
		}
	}
}

export default {
	async fetch(request: Request, env: { SURFACE: DurableObjectNamespace }): Promise<Response> {
		const url = new URL(request.url);
		try {
			switch (url.pathname) {
				case "/node/child-process":
					return Response.json({ stdout: execFileSync("/bin/echo", ["hi"], { encoding: "utf8" }).trim() });
				case "/node/fs": {
					const path = join(mkdtempSync(join(tmpdir(), "probe-")), "a.txt");
					writeFileSync(path, "on disk");
					return Response.json({ text: readFileSync(path, "utf8") });
				}
				case "/node/net-server": {
					const port = await new Promise<number>((resolve, reject) => {
						const server = createServer();
						server.once("error", reject);
						server.listen(0, "127.0.0.1", () => {
							const address = server.address();
							server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
						});
					});
					return Response.json({ port });
				}
				default:
					return env.SURFACE.get(env.SURFACE.idFromName("surface")).fetch(request);
			}
		} catch (error) {
			return Response.json({ error: error instanceof Error ? error.message : String(error) });
		}
	},
};
