import http from "node:http";
import { handleAsNodeRequest } from "cloudflare:node";

let currentPort;

// The fields of `req.socket` that Express and its middleware read.
function socketFields(socket) {
	return {
		encrypted: socket.encrypted,
		localAddress: socket.localAddress,
		localPortIsServerPort: socket.localPort === currentPort,
		remoteAddress: socket.remoteAddress,
		remoteFamily: socket.remoteFamily,
		remotePortIsEphemeral: socket.remotePort >= 0x8000 && socket.remotePort < 0x10000,
		hasOn: typeof socket.on === "function",
	};
}

export default {
	async fetch(request, env) {
		if (new URL(request.url).pathname !== "/run") return handleAsNodeRequest(currentPort, request);
		const server = http.createServer((req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(socketFields(req.socket)));
		});
		await new Promise((resolve) => server.listen(0, resolve));
		currentPort = server.address().port;
		try {
			const plain = await (await env.SERVICE.fetch("https://cloudflare.com/")).json();
			const forwarded = await (
				await env.SERVICE.fetch("https://cloudflare.com/", {
					headers: {
						"cf-connecting-ip": "2001:db8::1",
						host: "my-worker.example.com",
						"x-forwarded-proto": "https",
					},
				})
			).json();
			return Response.json({ plain, forwarded });
		} finally {
			server.close();
		}
	},
};
