function capture(callback) {
	try {
		return { type: "value", value: callback() };
	} catch (error) {
		return {
			type: "error",
			error: {
				name: error instanceof Error ? error.name : "Error",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

function responseObservations() {
	const pair = new WebSocketPair();
	const response = new Response(null, {
		headers: { "Sec-WebSocket-Protocol": "orange" },
		status: 101,
		webSocket: pair[0],
	});
	return {
		bodyIsNull: response.body === null,
		clone: capture(() => response.clone()),
		header: response.headers.get("sec-websocket-protocol"),
		instances: [pair[0] instanceof WebSocket, pair[1] instanceof WebSocket],
		keys: Object.keys(pair),
		missingSocket: capture(() => new Response(null, { status: 101 })),
		nonNullBody: capture(
			() => new Response("body", { status: 101, webSocket: pair[1] }),
		),
		ok: response.ok,
		states: [pair[0].readyState, pair[1].readyState],
		status: response.status,
		statusText: response.statusText,
		webSocketMatches: response.webSocket === pair[0],
		wrongStatus: capture(
			() => new Response(null, { status: 200, webSocket: pair[1] }),
		),
	};
}

async function frameObservations() {
	const pair = new WebSocketPair();
	const messages = [];
	pair[1].binaryType = "arraybuffer";
	const received = new Promise((resolve) => {
		pair[1].addEventListener("message", (event) => {
			messages.push(
				typeof event.data === "string"
					? event.data
					: [...new Uint8Array(event.data)],
			);
			if (messages.length === 2) resolve();
		});
	});
	pair[0].accept();
	pair[0].send("hello");
	const bytes = new Uint8Array([1, 2, 3]);
	pair[0].send(bytes);
	bytes.fill(9);
	await Promise.resolve();
	const beforeAccept = messages.length;
	pair[1].accept();
	await received;
	pair[0].close(1000, "done");
	return { beforeAccept, messages };
}

function validationObservations() {
	const socket = new WebSocketPair()[0];
	return {
		invalidCode: capture(() => socket.close(1005)),
		longReason: capture(() => socket.close(1000, "😀".repeat(31))),
		reasonWithoutCode: capture(() => socket.close(undefined, "reason")),
		sendBeforeAccept: capture(() => socket.send("early")),
	};
}

async function closeObservations() {
	const pair = new WebSocketPair();
	const closes = [];
	const finished = new Promise((resolve) => {
		for (const [name, socket] of [
			["first", pair[0]],
			["second", pair[1]],
		]) {
			socket.addEventListener("close", (event) => {
				closes.push({
					code: event.code,
					name,
					reason: event.reason,
					state: socket.readyState,
					wasClean: event.wasClean,
				});
				if (closes.length === 2) resolve();
			});
		}
	});
	pair[0].accept();
	pair[1].accept();
	pair[0].close(3001, "done");
	await finished;
	return {
		closes: closes.sort((left, right) => left.name.localeCompare(right.name)),
		states: [pair[0].readyState, pair[1].readyState],
	};
}

export default {
	async fetch(request) {
		try {
			const testCase = new URL(request.url).searchParams.get("case");
			const value =
				testCase === "response"
					? responseObservations()
					: testCase === "frames"
						? await frameObservations()
						: testCase === "validation"
							? validationObservations()
							: testCase === "close"
								? await closeObservations()
								: (() => {
										throw new Error(`Unknown WebSocket fixture case: ${testCase}`);
									})();
			return Response.json({ type: "value", value });
		} catch (error) {
			return Response.json({
				type: "error",
				error: {
					name: error instanceof Error ? error.name : "Error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	},
};
