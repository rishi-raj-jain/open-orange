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

function headersObservations() {
	const headers = new Headers([
		["X-Test", " first "],
		["x-test", "second"],
		["Set-Cookie", "a=1"],
		["Set-Cookie", "b=2"],
	]);
	headers.set("X-Set", "value");
	headers.append("X-Set", "other");
	headers.delete("X-Missing");
	const visited = [];
	headers.forEach((value, key, parent) => {
		visited.push([key, value, parent === headers]);
	});

	return {
		entries: [...headers],
		get: headers.get("X-Test"),
		getAllOther: capture(() => headers.getAll("x-test")),
		getSetCookie: headers.getSetCookie(),
		has: [headers.has("x-set"), headers.has("missing")],
		keys: [...headers.keys()],
		setCookies: headers.getAll("Set-Cookie"),
		values: [...headers.values()],
		visited,
	};
}

async function requestObservations() {
	const request = new Request("https://example.com/path?q=1", {
		body: "hello",
		cache: "no-cache",
		headers: { "X-Test": "value" },
		integrity: "",
		method: "POST",
		redirect: "manual",
	});
	const clone = request.clone();
	return {
		body: await request.text(),
		bodyUsed: request.bodyUsed,
		cache: request.cache,
		cloneBody: await clone.text(),
		headers: [...request.headers],
		integrity: request.integrity,
		integrityError: capture(
			() => new Request("https://example.com", { integrity: "sha256-example" }),
		),
		keepalive: request.keepalive,
		method: request.method,
		redirect: request.redirect,
		signalAborted: request.signal.aborted,
		url: request.url,
	};
}

async function responseObservations() {
	const response = new Response("payload", {
		headers: { "Content-Type": "text/plain", "X-Test": "value" },
		status: 201,
		statusText: "Created",
	});
	const clone = response.clone();
	const json = Response.json({ ok: true }, { status: 202 });
	const redirect = Response.redirect("https://example.com/next", 307);
	const error = Response.error();
	return {
		body: await response.text(),
		bodyUsed: response.bodyUsed,
		cloneBody: await clone.text(),
		error: {
			ok: error.ok,
			status: error.status,
			type: error.type,
		},
		headers: [...response.headers],
		json: {
			body: await json.text(),
			contentType: json.headers.get("content-type"),
			status: json.status,
		},
		ok: response.ok,
		redirect: {
			location: redirect.headers.get("location"),
			status: redirect.status,
		},
		redirected: response.redirected,
		status: response.status,
		statusText: response.statusText,
		type: response.type,
		url: response.url,
	};
}

export default {
	async fetch(request) {
		try {
			const testCase = new URL(request.url).searchParams.get("case");
			const value =
				testCase === "headers"
					? headersObservations()
					: testCase === "request"
						? await requestObservations()
						: testCase === "response"
							? await responseObservations()
							: (() => {
									throw new Error(`Unknown HTTP fixture case: ${testCase}`);
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
