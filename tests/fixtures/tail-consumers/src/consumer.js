import { summarize } from "./summary.js";

const received = [];
// The paths of each tail() call that returned.
const batches = [];
// How many tail() calls got each path, including calls that threw.
const attempts = {};

export default {
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/batches") return Response.json(batches);
		if (url.pathname === "/attempts") return Response.json(attempts);
		const path = url.searchParams.get("path");
		return Response.json(received.filter((event) => event.path === path));
	},

	async tail(events, env) {
		const summaries = events.map(summarize);
		for (const { path } of summaries) attempts[path] = (attempts[path] ?? 0) + 1;
		// The first two calls with this event throw.
		if (summaries.some(({ path }) => path === "/tail-throws" && attempts[path] <= 2)) {
			throw new Error("tail() failed");
		}
		// Never returns, so the test can kill the runtime while tail() runs.
		if (env.HANG_TAIL === "1" && summaries.some(({ path }) => path === "/tail-hangs")) {
			await new Promise(() => {});
		}
		for (const summary of summaries) received.push(summary);
		batches.push(summaries.map(({ path }) => path));
	},
};
