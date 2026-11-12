// A plain Worker with one D1 database. It runs as is on Cloudflare and on Orange.
export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (pathname === "/owner") {
			const name = await request.text();
			const { meta } = await env.DB.prepare("INSERT INTO owners(name) VALUES (?)").bind(name).run();
			return Response.json({ id: meta.last_row_id });
		}
		if (pathname === "/pet") {
			await env.DB.prepare("INSERT INTO pets(owner, note) VALUES (1, ?)").bind(await request.text()).run();
			return Response.json({ ok: true });
		}
		if (pathname === "/batch-meta") {
			const statements = await request.json();
			const results = await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
			return Response.json(results.map(({ meta }) => meta));
		}
		const [owners, pets, audit, view, indexes] = await env.DB.batch([
			env.DB.prepare("SELECT id, name FROM owners ORDER BY id"),
			env.DB.prepare("SELECT id, owner, hex(blob) AS blob, price, note FROM pets ORDER BY id"),
			env.DB.prepare("SELECT what FROM audit ORDER BY id"),
			env.DB.prepare("SELECT id, name FROM pet_names ORDER BY id"),
			env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'pets_owner'"),
		]);
		return Response.json({
			audit: audit.results.map(({ what }) => what),
			index: indexes.results.length === 1,
			owners: owners.results,
			pets: pets.results,
			view: view.results,
		});
	},
};
