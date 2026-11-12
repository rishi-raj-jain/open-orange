function outcome(run) {
	try {
		const event = run();
		return {
			ports: event.ports.length,
			portsFrozen: Object.isFrozen(event.ports),
			source: event.source === null ? null : typeof event.source,
		};
	} catch (error) {
		return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	}
}

function initObservations() {
	const { port1, port2 } = new MessageChannel();
	const portLike = { close() {}, postMessage() {}, start() {} };
	return {
		ports: outcome(() => new MessageEvent("message", { ports: [port1, port2] })),
		source: outcome(() => new MessageEvent("message", { source: port1 })),
		portLike: outcome(() => new MessageEvent("message", { ports: [portLike] })),
		nullPort: outcome(() => new MessageEvent("message", { ports: [null] })),
		stringPorts: outcome(() => new MessageEvent("message", { ports: "ab" })),
		nullPorts: outcome(() => new MessageEvent("message", { ports: null })),
		setPorts: outcome(() => new MessageEvent("message", { ports: new Set([port1]) })),
		portLikeSource: outcome(() => new MessageEvent("message", { source: portLike })),
		nullSource: outcome(() => new MessageEvent("message", { source: null })),
	};
}

export default {
	async fetch(request) {
		const testCase = new URL(request.url).searchParams.get("case");
		if (testCase !== "init") {
			return Response.json({
				type: "error",
				error: { name: "Error", message: `Unknown MessageEvent fixture case: ${testCase}` },
			});
		}
		return Response.json({ type: "value", value: initObservations() });
	},
};
