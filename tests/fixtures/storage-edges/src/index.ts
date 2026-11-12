import { DurableObject } from "cloudflare:workers";

interface Env {
	STORE: DurableObjectNamespace<Store>;
}

function describeError(error: unknown): unknown {
	if (!(error instanceof Error)) return { thrown: String(error) };
	return {
		code: Reflect.get(error, "code"),
		isDOMException: error instanceof DOMException,
		isTypeError: error instanceof TypeError,
		message: error.message,
		name: error.name,
	};
}

async function settle(run: () => unknown): Promise<unknown> {
	try {
		const value = await run();
		return { value: value instanceof Map ? Object.fromEntries(value) : value ?? null };
	} catch (error) {
		return { error: describeError(error) };
	}
}

export class Store extends DurableObject<Env> {
	async keyValueEdges(): Promise<unknown> {
		const storage = this.ctx.storage;
		const keys = Array.from({ length: 129 }, (_, index) => `k${index}`);
		await storage.put({ a: 1, b: 2, c: 3, undefined: "stored under the string undefined" });
		return {
			put129: await settle(() => storage.put(Object.fromEntries(keys.map((key) => [key, 1])))),
			get129: await settle(async () => (await storage.get(keys)).size),
			delete129: await settle(() => storage.delete(keys)),
			getUndefinedKey: await settle(() => storage.get(undefined as unknown as string)),
			listFractionalLimit: await settle(async () => [...(await storage.list({ limit: 1.5 })).keys()]),
			putFunction: await settle(() => storage.put("f", () => 1)),
		};
	}

	async sqlBindings(): Promise<unknown> {
		const sql = this.ctx.storage.sql;
		const bound = (value: unknown) => settle(() => sql.exec("SELECT ? AS v, typeof(?) AS t", value, value).one());
		return {
			boolean: await bound(true),
			object: await bound({ a: 1 }),
			bigint: await bound(10n),
			numericNamed: await settle(() => sql.exec("SELECT $1 AS dollar, :1 AS colon, @1 AS at, $1 AS again", 1, 2, 3).one()),
			numericNamedTooFew: await settle(() => sql.exec("SELECT $1 AS v").one()),
		};
	}

	sqlIngest(): unknown {
		const sql = this.ctx.storage.sql as SqlStorage & {
			ingest(query: string): { remainder: string; rowsRead: number; rowsWritten: number; statementCount: number };
		};
		const remainders = [
			"SELECT 123; SELECT 456;    ",
			"SELECT 123; SELECT 45",
			"SELECT 'a;b'; SELECT 1 -- ;",
			"SELECT 1; /* ; */ SELECT 2;",
			"CREATE TRIGGER IF NOT EXISTS t AFTER INSERT ON ingested BEGIN SELECT 1; END",
		].map((query) => sql.ingest(query).remainder);
		sql.exec("CREATE TABLE ingested (id INTEGER PRIMARY KEY)");
		const counts = sql.ingest("INSERT INTO ingested VALUES (1); INSERT INTO ingested VALUES (2); INSERT INTO");
		// A failing statement throws, and the statements before it stay applied.
		let failure: unknown;
		try {
			sql.ingest("INSERT INTO ingested VALUES (3); INSERT INTO ingested VALUES (3); INSERT INTO ingested VALUES (4);");
		} catch (error) {
			failure = describeError(error);
		}
		const rows = sql.exec("SELECT id FROM ingested ORDER BY id").toArray().map((row) => row.id);
		return { counts, failure, remainders, rows };
	}

	async sqlWithoutStatement(): Promise<unknown> {
		const sql = this.ctx.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS commented (id INTEGER PRIMARY KEY)");
		return {
			empty: await settle(() => sql.exec("").toArray()),
			whitespace: await settle(() => sql.exec("   ").toArray()),
			semicolon: await settle(() => sql.exec(";").toArray()),
			trailingWhitespace: await settle(() => sql.exec("SELECT 1 AS one;  \n").toArray()),
			trailingComment: await settle(() => sql.exec("SELECT 1 AS one; -- comment").toArray()),
			insertThenComment: await settle(() => sql.exec("INSERT INTO commented VALUES (1); /* comment */").toArray()),
			rows: sql.exec("SELECT id FROM commented").toArray(),
		};
	}

	async transactionEdges(): Promise<unknown> {
		const storage = this.ctx.storage;
		return {
			deleteAll: await settle(() => storage.transaction((txn) => txn.deleteAll())),
			putAfterRollback: await settle(() =>
				storage.transaction(async (txn) => {
					txn.rollback();
					await txn.put("a", 2);
				}),
			),
		};
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		const stub = env.STORE.getByName(pathname);
		if (pathname === "/stub-proxy") {
			const proxied = new Proxy(stub, { get: () => "from-the-proxy" }) as unknown as { id: unknown; name: unknown };
			return Response.json(await settle(() => ({ id: proxied.id, name: proxied.name })));
		}
		if (pathname === "/key-value") return Response.json(await stub.keyValueEdges());
		if (pathname === "/sql-bindings") return Response.json(await stub.sqlBindings());
		if (pathname === "/transaction") return Response.json(await stub.transactionEdges());
		if (pathname === "/sql-ingest") return Response.json(await stub.sqlIngest());
		if (pathname === "/sql-without-statement") return Response.json(await stub.sqlWithoutStatement());
		return new Response("not found", { status: 404 });
	},
};
