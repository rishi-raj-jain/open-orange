// What a queue() handler sees of each message body, in a form that survives JSON.
function describe(value) {
	if (value instanceof Headers) return { kind: "Headers", entries: [...value] };
	if (value instanceof Request) {
		return { kind: "Request", url: value.url, method: value.method, headers: [...value.headers] };
	}
	if (value instanceof Response) {
		return { kind: "Response", status: value.status, statusText: value.statusText, type: value.type, headers: [...value.headers] };
	}
	if (value instanceof DOMException) {
		return { kind: "DOMException", name: value.name, message: value.message, stack: value.stack };
	}
	if (value instanceof Error) {
		return { kind: "Error", class: value.constructor.name, name: value.name, message: value.message, code: value.code, stack: value.stack === "secret" ? "restored" : "own" };
	}
	return { kind: "value", value };
}

const seen = new Map();

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const queue = url.searchParams.get("queue") ?? "q";
		const options = JSON.parse(url.searchParams.get("options") ?? "{}");
		try {
			const message = { id: options.id ?? "m1", timestamp: new Date(0), attempts: 3 };
			if (url.pathname === "/serialized") message.serializedBody = await request.arrayBuffer();
			if (url.pathname === "/body") message.body = options.body;
			if (url.pathname === "/both") {
				message.body = 1;
				message.serializedBody = new ArrayBuffer(0);
			}
			const result = await env.SERVICE.queue(queue, [message], { metrics: { backlogCount: 7, backlogBytes: 8, oldestMessageTimestamp: 9 } });
			return Response.json({ result, seen: seen.get(queue) });
		} catch (error) {
			return Response.json({ thrown: error.constructor.name, message: error.message }, { status: 500 });
		}
	},
	async queue(batch) {
		const metrics = batch.metadata.metrics;
		seen.set(batch.queue, {
			attempts: batch.messages[0].attempts,
			body: describe(batch.messages[0].body),
			oldest: metrics.oldestMessageTimestamp instanceof Date ? metrics.oldestMessageTimestamp.getTime() : "not a Date",
			backlog: [metrics.backlogCount, metrics.backlogBytes],
		});
		const [action, delay] = batch.queue.split("-");
		if (action === "ack") batch.messages[0].ack();
		if (action === "ackall") batch.ackAll();
		if (action === "retry") batch.messages[0].retry({ delaySeconds: Number(delay) });
		if (action === "retryall") batch.retryAll({ delaySeconds: Number(delay) });
		if (action === "throw") throw new Error("the handler failed");
	},
};
