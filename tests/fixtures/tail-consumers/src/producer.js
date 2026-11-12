import { summarize } from "./summary.js";

const received = [];

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/events") {
			const path = url.searchParams.get("path");
			return Response.json(received.filter((event) => event.path === path));
		}
		if (url.pathname === "/consumer-events") {
			return env.CONSUMER.fetch(`http://consumer/events?path=${url.searchParams.get("path")}`);
		}
		if (url.pathname === "/consumer-batches") return env.CONSUMER.fetch("http://consumer/batches");
		if (url.pathname === "/consumer-attempts") return env.CONSUMER.fetch("http://consumer/attempts");
		if (url.pathname.startsWith("/overlap/")) {
			const tag = url.pathname.slice("/overlap/".length);
			console.log(`${tag} first`);
			await scheduler.wait(100);
			console.log(`${tag} second`);
			return new Response(tag);
		}
		if (url.pathname === "/throws") {
			console.warn("about to throw", new RangeError("out of range"));
			throw new TypeError("boom");
		}
		console.log("plain", 1, { a: 1 }, [2, null], null, undefined, new Map([[1, 2]]));
		console.error(new Error("logged"));
		console.info({ toJSON: () => "custom" });
		return new Response("ok", { status: 201 });
	},

	tail(events) {
		for (const event of events) received.push(summarize(event));
	},
};
