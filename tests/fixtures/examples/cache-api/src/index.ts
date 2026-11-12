// A caching proxy in front of a slow origin. GET and HEAD requests are served
// from the Cache API when possible, and every response says whether it was a
// HIT or a MISS in `cf-cache-status`.

const originDelayMs = 300;

// Stands in for a slow origin server. Each path sets its own Cache-Control,
// which decides whether and for how long the proxy may cache it.
async function origin(path: string): Promise<Response> {
	await new Promise((resolve) => setTimeout(resolve, originDelayMs));
	const renderedAt = new Date().toISOString();
	const version = crypto.randomUUID();

	let match = /^\/articles\/([\w-]+)$/.exec(path);
	if (match !== null) {
		return Response.json(
			{ article: match[1], renderedAt, version },
			{ headers: { "cache-control": "public, max-age=60", etag: `"${version}"` } },
		);
	}
	match = /^\/scores\/([\w-]+)$/.exec(path);
	if (match !== null) {
		// Live scores go stale after one second.
		return Response.json(
			{ game: match[1], renderedAt, version },
			{ headers: { "cache-control": "max-age=1" } },
		);
	}
	if (path === "/me") {
		// Per-user data. A shared cache must not store it.
		return Response.json(
			{ renderedAt, user: "ada", version },
			{ headers: { "cache-control": "private" } },
		);
	}
	if (path === "/live") {
		return Response.json({ renderedAt, version }, { headers: { "cache-control": "no-store" } });
	}
	match = /^\/videos\/([\w-]+)$/.exec(path);
	if (match !== null) {
		// 1 KiB of the bytes 0 to 255, repeated, so ranges are easy to check.
		const bytes = Uint8Array.from({ length: 1024 }, (_, index) => index % 256);
		return new Response(bytes, {
			headers: {
				"cache-control": "public, max-age=300",
				"content-type": "video/mp4",
				etag: `"${version}"`,
			},
		});
	}
	return new Response("Not found", { headers: { "cache-control": "no-store" }, status: 404 });
}

async function proxy(request: Request, cache: Cache, path: string): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		const response = new Response((await origin(path)).body, { status: 405 });
		response.headers.set("cf-cache-status", "BYPASS");
		return response;
	}
	// Passing the incoming request lets match() answer If-None-Match with 304
	// and Range with 206. ignoreMethod lets HEAD reuse the GET entry.
	const cached = await cache.match(request, { ignoreMethod: true });
	if (cached !== undefined) {
		return request.method === "HEAD" ? new Response(null, cached) : cached;
	}

	const response = await origin(path);
	// Read the body once and build two responses from the bytes: one to
	// store and one to return. The key is the URL, so the entry does not
	// depend on the request's Range or conditional headers. put() skips
	// responses that say no-store or private. Production Workers often wrap
	// this in ctx.waitUntil() so the client does not wait for the write;
	// awaiting it here means the very next request sees the entry.
	const body = await response.arrayBuffer();
	await cache.put(request.url, new Response(body, response));
	const miss = new Response(request.method === "HEAD" ? null : body, response);
	miss.headers.set("cf-cache-status", "MISS");
	return miss;
}

// Named caches are separate from caches.default and from each other.
async function namedCache(name: string | null): Promise<Cache> {
	return name === null || name === "default" ? caches.default : await caches.open(name);
}

export default {
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);

		// POST /purge {"path":"/articles/a","cache":"thumbnails"} removes one entry.
		if (url.pathname === "/purge" && request.method === "POST") {
			const { cache, path } = await request.json<{ cache?: string; path?: string }>();
			if (typeof path !== "string" || !path.startsWith("/")) {
				return Response.json({ error: 'Send JSON like {"path":"/articles/a"}' }, { status: 400 });
			}
			const target = await namedCache(cache ?? null);
			return Response.json({ deleted: await target.delete(new URL(path, url).toString()) });
		}

		// GET /peek?path=/articles/a&cache=thumbnails says whether an entry exists.
		if (url.pathname === "/peek") {
			const path = url.searchParams.get("path") ?? "/";
			const target = await namedCache(url.searchParams.get("cache"));
			return Response.json({ cached: (await target.match(new URL(path, url).toString())) !== undefined });
		}

		// /thumbs/<path> proxies <path> through a named cache instead of the default one.
		if (url.pathname.startsWith("/thumbs/")) {
			return proxy(request, await caches.open("thumbnails"), url.pathname.slice("/thumbs".length));
		}

		return proxy(request, caches.default, url.pathname);
	},
} satisfies ExportedHandler;
