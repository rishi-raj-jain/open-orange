import { WorkerEntrypoint } from "cloudflare:workers";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function readAll(readable) {
	let text = "";
	for await (const chunk of readable) text += decoder.decode(chunk, { stream: true });
	return text + decoder.decode();
}

// Answers once a whole line has arrived, then closes, which the caller sees as the end of its readable.
export class Echo extends WorkerEntrypoint {
	async connect(socket) {
		const { localAddress } = await socket.opened;
		let received = "";
		const reader = socket.readable.getReader();
		while (!received.endsWith("\n")) {
			const { done, value } = await reader.read();
			if (done) throw new Error("the caller left early");
			received += decoder.decode(value, { stream: true });
		}
		const writer = socket.writable.getWriter();
		await writer.write(encoder.encode(`${localAddress}|${received.trim()}`));
		await writer.close();
	}
}

export class NoHandler extends WorkerEntrypoint {}

export class Throws extends WorkerEntrypoint {
	async connect() {
		throw new Error("the handler failed");
	}
}

async function talk(binding, address, message) {
	const socket = binding.connect(address);
	await socket.opened;
	const writer = socket.writable.getWriter();
	await writer.write(encoder.encode(`${message}\n`));
	const answer = await readAll(socket.readable);
	await socket.closed;
	return answer;
}

async function failure(binding) {
	try {
		const socket = binding.connect("example.com:1");
		await socket.opened;
		return "opened";
	} catch (error) {
		return error.message;
	}
}

// A handler that throws has already opened the socket, so the caller sees its readable end.
async function ended(binding) {
	const socket = binding.connect("example.com:1");
	await socket.opened;
	await readAll(socket.readable).catch(() => undefined);
	return "ended";
}

export default {
	async fetch(request, env) {
		const path = new URL(request.url).pathname;
		if (path === "/echo") return Response.json(await talk(env.ECHO, "example.com:1234", "hello"));
		if (path === "/overlap") {
			const names = ["a", "b", "c", "d"];
			return Response.json(await Promise.all(names.map((name) => talk(env.ECHO, `${name}.example.com:1`, name.repeat(70_000)))));
		}
		if (path === "/failures") {
			return Response.json({
				noHandler: await failure(env.NO_HANDLER),
				stopped: await failure(env.STOPPED),
				throws: await ended(env.THROWS),
			});
		}
		return new Response("ok");
	},
};
