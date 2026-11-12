import http from "node:http";
import { httpServerHandler } from "cloudflare:node";

const server = http.createServer((req, res) => {
	const path = new URL(req.url, "http://worker").pathname;
	if (path === "/destroy-with-error") {
		req.on("error", (error) => {
			res.statusCode = 400;
			res.end(`Request destroyed: ${error.message}`);
		});
		req.destroy(new Error("Destroy test"));
	} else if (path === "/destroy-without-error") {
		req.on("error", () => res.end("unexpected error event"));
		req.on("close", () => res.end("Request destroyed without error"));
		req.destroy();
	} else if (path === "/too-few") {
		res.writeHead(200, { "Content-Length": "20" });
		res.write("0123456789");
		res.end();
	} else if (path === "/too-many") {
		res.writeHead(200, { "Content-Length": "10" });
		res.write("0123456789");
		res.write("0123456789");
		res.end();
	} else {
		res.statusCode = 404;
		res.end();
	}
});
server.listen(8080);

const handler = httpServerHandler({ port: 8080 });

export default {
	// `/read/<path>` reads the server's response inside the Worker, as a service binding caller
	// does, and returns what it read. This leaves out how the outer HTTP layer frames the body.
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/read/")) return handler.fetch(request, env, ctx);
		url.pathname = url.pathname.slice("/read".length);
		try {
			const response = await handler.fetch(new Request(url), env, ctx);
			return Response.json({ status: response.status, body: await response.text() });
		} catch (error) {
			return Response.json({ error: String(error) });
		}
	},
};
