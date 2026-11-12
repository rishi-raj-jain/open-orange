import { WorkerEntrypoint } from "cloudflare:workers";

const encoder = new TextEncoder();

export class Peer extends WorkerEntrypoint {
	async writeTo(stream) {
		const writer = stream.getWriter();
		await writer.write(encoder.encode("written"));
		await writer.close();
	}

	async readFrom(stream) {
		return await new Response(stream).text();
	}
}

// Replaces the public stream methods, as a Worker may. Orange's own transfers must not call these.
function trapStreams() {
	const trapped = [];
	const originals = [
		[WritableStream.prototype, "getWriter"],
		[WritableStreamDefaultWriter.prototype, "write"],
		[WritableStreamDefaultWriter.prototype, "close"],
		[WritableStreamDefaultWriter.prototype, "abort"],
		[ReadableStream.prototype, "getReader"],
	].map(([prototype, name]) => {
		const original = prototype[name];
		prototype[name] = function (...args) {
			trapped.push(name);
			return Reflect.apply(original, this, args);
		};
		return () => {
			prototype[name] = original;
		};
	});
	return {
		restore() {
			for (const restore of originals) restore();
		},
		trapped,
	};
}

async function exercise(peer) {
	const { readable, writable } = new IdentityTransformStream();
	const writing = peer.writeTo(writable);
	const written = await new Response(readable).text();
	await writing;
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode("read"));
			controller.close();
		},
	});
	return { read: await peer.readFrom(stream), written };
}

export default {
	async fetch(request, env) {
		if (new URL(request.url).pathname === "/user") {
			// The trap must still work for the Worker's own calls.
			const traps = trapStreams();
			try {
				new ReadableStream().getReader();
				return Response.json(traps.trapped);
			} finally {
				traps.restore();
			}
		}
		const peer = new URL(request.url).pathname === "/local" ? env.LOCAL : env.REMOTE;
		const traps = trapStreams();
		try {
			const result = await exercise(peer);
			return Response.json({ ...result, trapped: [...traps.trapped] });
		} catch (error) {
			return Response.json({ error: error.message, trapped: [...traps.trapped] });
		} finally {
			traps.restore();
		}
	},
};
