const seen = new Map();

export const noHandler = {};

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/headers") return Response.json(Object.fromEntries(request.headers));
		if (url.pathname === "/stream") {
			const { readable, writable } = new IdentityTransformStream();
			const writer = writable.getWriter();
			void writer.write(new Uint8Array([1, 2, 3]));
			void writer.close();
			return env.SERVICE.fetch("http://placeholder/headers", { body: readable, method: "POST" });
		}
		if (url.pathname === "/buffer") {
			return env.SERVICE.fetch("http://placeholder/headers", { body: "abc", method: "POST" });
		}
		if (url.pathname === "/none") return Response.json(await env.NO_HANDLER.scheduled());
		const options = url.searchParams.has("options") ? JSON.parse(url.searchParams.get("options")) : undefined;
		const result = await env.SERVICE.scheduled(options);
		return Response.json({ result, seen: seen.get(options?.cron ?? "") });
	},
	scheduled(controller) {
		seen.set(controller.cron, { cron: controller.cron, scheduledTime: controller.scheduledTime });
		if (controller.cron === "no-retry") controller.noRetry();
		if (controller.cron === "throws") throw new Error("the handler failed");
	},
};
