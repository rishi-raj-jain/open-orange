export const NamedEntrypoint = class NamedEntrypoint {};

interface FixtureExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
}

export default {
	async fetch(
		request: Request,
		_environment: Record<string, unknown>,
		context?: FixtureExecutionContext,
	): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/error") {
			throw new Error("fixture request failure");
		}
		if (pathname === "/background") {
			context?.waitUntil(Promise.reject(new Error("fixture background failure")));
		}
		if (pathname === "/unhandled-rejection") {
			void Promise.reject(new Error("fixture unhandled rejection"));
		}
		if (pathname === "/uncaught-exception") {
			setTimeout(() => {
				throw new Error("fixture uncaught exception");
			}, 0);
		}
		if (pathname === "/request-stream") {
			const reader = request.body?.getReader();
			if (reader === undefined) throw new Error("fixture request has no body");
			const first = await reader.read();
			await reader.cancel();
			return new Response(first.value);
		}
		if (pathname === "/response-stream") {
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("first"));
					},
				}),
			);
		}
		return new Response(pathname);
	},
};
