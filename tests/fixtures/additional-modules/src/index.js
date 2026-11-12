import { readdirSync, readFileSync, writeFileSync } from "node:fs";

export default {
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/files") {
			const files = readdirSync("/bundle", { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => `${entry.parentPath}/${entry.name}`.replace("/bundle/", ""))
				.filter((name) => name !== "worker")
				.sort();
			return Response.json(files);
		}
		const path = `/bundle/${url.searchParams.get("path")}`;
		try {
			if (url.pathname === "/write") {
				writeFileSync(path, "changed");
				return new Response("written");
			}
			return new Response(readFileSync(path));
		} catch (error) {
			return new Response(error.code, { status: 500 });
		}
	},
};
