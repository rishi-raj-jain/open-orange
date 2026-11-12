interface Env {
	DB: D1Database;
}

type Comment = { id: number; author: string; content: string };

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/comments") {
			return new Response("Try GET or POST /comments", { status: 404 });
		}

		if (request.method === "POST") {
			const body = await request.json<Partial<Comment>>().catch(() => ({}) as Partial<Comment>);
			if (typeof body.author !== "string" || typeof body.content !== "string") {
				return Response.json(
					{ error: "Send JSON with string author and content fields" },
					{ status: 400 },
				);
			}
			const comment = await env.DB.prepare(
				"INSERT INTO comments (author, content) VALUES (?, ?) RETURNING *",
			)
				.bind(body.author, body.content)
				.first<Comment>();
			return Response.json(comment, { status: 201 });
		}

		const author = url.searchParams.get("author");
		const statement =
			author === null
				? env.DB.prepare("SELECT * FROM comments ORDER BY id")
				: env.DB.prepare("SELECT * FROM comments WHERE author = ? ORDER BY id").bind(author);
		const { results } = await statement.all<Comment>();
		return Response.json({ comments: results });
	},
} satisfies ExportedHandler<Env>;
