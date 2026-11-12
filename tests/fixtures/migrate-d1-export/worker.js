// A plain Worker with one D1 database. It runs as is on Cloudflare and on Orange.
// `/sql` runs a batch and says which database served it. `/dump` reads every table in exact form, in
// key order, so a test can compare the two sides value for value. It leaves out the rowid of a table
// without INTEGER PRIMARY KEY: no D1 export keeps it.

// TEXT compares by its bytes, so invalid UTF-8 that a JS string would replace still counts.
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const tagged = (column) =>
	`CASE typeof(${quote(column)}) WHEN 'integer' THEN 'i' || ${quote(column)} WHEN 'real' THEN 'r' || printf('%!.17g', ${quote(column)}) WHEN 'text' THEN 't' || hex(${quote(column)}) WHEN 'blob' THEN 'b' || hex(${quote(column)}) END`;

function parameter(value) {
	if (value !== null && typeof value === "object" && typeof value.$blob === "string") {
		return new Uint8Array(value.$blob.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
	}
	return value;
}

async function dump(db) {
	const { results: tables } = await db
		.prepare(
			`SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name`,
		)
		.all();
	const out = {};
	for (const { name, wr } of tables) {
		const { results: columns } = await db.prepare("SELECT name, pk FROM pragma_table_info(?) ORDER BY cid").bind(name).all();
		const order = wr === 1 ? columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => quote(column.name)).join(", ") : "rowid";
		const { results } = await db
			.prepare(`SELECT json_array(${columns.map((column) => column.name).map(tagged).join(", ")}) AS r FROM ${quote(name)} ORDER BY ${order}`)
			.all();
		out[name] = results.map(({ r }) => JSON.parse(r));
	}
	return out;
}

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (pathname === "/sql") {
			const { statements } = await request.json();
			try {
				const results = await env.DB.batch(statements.map(({ params = [], sql }) => env.DB.prepare(sql).bind(...params.map(parameter))));
				return Response.json(
					results.map(({ meta, results: rows }) => ({ changes: meta.changes, lastRowId: meta.last_row_id, rows, servedBy: meta.served_by })),
				);
			} catch (error) {
				return Response.json({ error: String(error?.message ?? error) }, { status: 500 });
			}
		}
		if (pathname === "/first") {
			const { params = [], sql } = await request.json();
			return Response.json({ row: await env.DB.prepare(sql).bind(...params.map(parameter)).first() });
		}
		if (pathname === "/raw") {
			const { params = [], sql } = await request.json();
			return Response.json({ rows: await env.DB.prepare(sql).bind(...params.map(parameter)).raw({ columnNames: true }) });
		}
		if (pathname === "/exec") {
			const { sql } = await request.json();
			return Response.json(await env.DB.exec(sql));
		}
		if (pathname === "/dump") return Response.json(await dump(env.DB));
		return new Response("not found", { status: 404 });
	},
};
