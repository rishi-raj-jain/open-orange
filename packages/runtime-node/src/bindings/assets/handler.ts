import { Headers, Response, type Request } from "../../globals/http.js";
import type {
	RuntimeAssetsHtmlHandling,
	RuntimeAssetsNotFoundHandling,
} from "../../process-protocol.js";

// Serves a request from the assets directory like Cloudflare's asset Worker.
// The path resolution below is a port of its handler, without `_redirects`
// and `_headers` rules.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/asset-worker/src/handler.ts#L39-L268

export interface AssetEntry {
	contentType: string | null;
	eTag: string;
	path: string;
}

// Finds the asset stored at a decoded path such as `/docs/index.html`.
export type AssetLookup = (pathname: string) => Promise<AssetEntry | null>;

export type AssetBody = (asset: AssetEntry) => ReadableStream<Uint8Array>;

export interface AssetHandlerConfiguration {
	hasStaticRouting: boolean;
	htmlHandling: RuntimeAssetsHtmlHandling;
	navigationPrefersAssetServing: boolean;
	notFoundHandling: RuntimeAssetsNotFoundHandling;
}

type Intent =
	| { asset: AssetEntry; redirect: null; status: 200 | 404 }
	| { asset: null; redirect: string }
	| null;

const noIntent = Symbol("no asset intent");

// The asset Worker asks browsers to revalidate every asset.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/asset-worker/src/constants.ts#L1-L2
const CACHE_CONTROL_BROWSER = "public, max-age=0, must-revalidate";

function serve(asset: AssetEntry, status: 200 | 404 = 200): Intent {
	return { asset, redirect: null, status };
}

function redirect(location: string, search: string): Response {
	return new Response(null, {
		headers: { Location: location + search },
		status: 307,
		statusText: "Temporary Redirect",
	});
}

function notFoundResponse(
	body: ReadableStream<Uint8Array> | null = null,
	headers?: Headers,
): Response {
	return new Response(body, {
		...(headers === undefined ? {} : { headers }),
		status: 404,
		statusText: "Not Found",
	});
}

async function getResponseOrAssetIntent(
	request: Request,
	configuration: AssetHandlerConfiguration,
	exists: AssetLookup,
): Promise<Response | typeof noIntent | { asset: AssetEntry; status: 200 | 404 }> {
	const { pathname, search } = new URL(request.url);
	const decodedPathname = decodePath(pathname);
	const intent = await getIntent(decodedPathname, configuration, exists, false);
	if (intent === null) return noIntent;

	const method = request.method.toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		return new Response(null, { status: 405, statusText: "Method Not Allowed" });
	}

	// The canonical path of an asset is its decoded and re-encoded path, so a
	// request for any other spelling redirects there.
	const encodedDestination = encodePath(intent.redirect ?? decodedPathname);
	if (intent.redirect !== null || encodedDestination !== pathname) {
		return redirect(encodedDestination, search);
	}
	return intent;
}

function assetResponse(
	request: Request,
	intent: { asset: AssetEntry; status: 200 | 404 },
	body: AssetBody,
): Response {
	// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/asset-worker/src/utils/headers.ts#L19-L61
	const strongETag = `"${intent.asset.eTag}"`;
	const headers = new Headers({ ETag: strongETag });
	if (intent.asset.contentType !== null) {
		headers.append("Content-Type", intent.asset.contentType);
	}
	if (!request.headers.has("Authorization") && !request.headers.has("Range")) {
		headers.append("Cache-Control", CACHE_CONTROL_BROWSER);
	}
	// The asset Worker reports a cache hit when its storage read is fast, which
	// every local read is.
	headers.append("CF-Cache-Status", "HIT");

	const ifNoneMatch = request.headers.get("If-None-Match") ?? "";
	if (ifNoneMatch === strongETag || ifNoneMatch === `W/${strongETag}`) {
		return new Response(null, { headers, status: 304, statusText: "Not Modified" });
	}
	const responseBody = request.method.toUpperCase() === "HEAD" ? null : body(intent.asset);
	return intent.status === 404
		? notFoundResponse(responseBody, headers)
		: new Response(responseBody, { headers, status: 200 });
}

// The router asks whether assets handle a request before it runs the Worker.
// Without static routing, only a navigation request uses not_found_handling.
export async function canFetch(
	request: Request,
	configuration: AssetHandlerConfiguration,
	exists: AssetLookup,
): Promise<boolean> {
	const keepNotFoundHandling =
		configuration.hasStaticRouting ||
		(configuration.navigationPrefersAssetServing &&
			request.headers.get("Sec-Fetch-Mode") === "navigate");
	const result = await getResponseOrAssetIntent(
		request,
		keepNotFoundHandling ? configuration : { ...configuration, notFoundHandling: "none" },
		exists,
	);
	return result !== noIntent;
}

export async function handleRequest(
	request: Request,
	configuration: AssetHandlerConfiguration,
	exists: AssetLookup,
	body: AssetBody,
): Promise<Response> {
	const result = await getResponseOrAssetIntent(request, configuration, exists);
	if (result === noIntent) return notFoundResponse();
	if (result instanceof Response) return result;
	return assetResponse(request, result, body);
}

// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/asset-worker/src/handler.ts#L303-L342
function getIntent(
	pathname: string,
	configuration: AssetHandlerConfiguration,
	exists: AssetLookup,
	skipRedirects: boolean,
): Promise<Intent> {
	switch (configuration.htmlHandling) {
		case "auto-trailing-slash":
			return htmlHandlingAutoTrailingSlash(pathname, configuration, exists, skipRedirects);
		case "force-trailing-slash":
			return htmlHandlingForceTrailingSlash(pathname, configuration, exists, skipRedirects);
		case "drop-trailing-slash":
			return htmlHandlingDropTrailingSlash(pathname, configuration, exists, skipRedirects);
		case "none":
			return htmlHandlingNone(pathname, configuration, exists);
	}
}

// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/asset-worker/src/handler.ts#L344-L504
async function htmlHandlingAutoTrailingSlash(
	pathname: string,
	configuration: AssetHandlerConfiguration,
	exists: AssetLookup,
	skip: boolean,
): Promise<Intent> {
	const redirectTo = (file: string, destination: string): Promise<Intent> =>
		safeRedirect(file, destination, configuration, exists, skip);
	let result: Intent;
	let asset: AssetEntry | null;
	const exact = await exists(pathname);
	if (pathname.endsWith("/index")) {
		if (exact) return serve(exact);
		if ((result = await redirectTo(`${pathname}.html`, pathname.slice(0, -"index".length)))) {
			return result;
		}
		if (
			(result = await redirectTo(
				`${pathname.slice(0, -"/index".length)}.html`,
				pathname.slice(0, -"/index".length),
			))
		) {
			return result;
		}
	} else if (pathname.endsWith("/index.html")) {
		if ((result = await redirectTo(pathname, pathname.slice(0, -"index.html".length)))) {
			return result;
		}
		if (
			(result = await redirectTo(
				`${pathname.slice(0, -"/index.html".length)}.html`,
				pathname.slice(0, -"/index.html".length),
			))
		) {
			return result;
		}
	} else if (pathname.endsWith("/")) {
		if ((asset = await exists(`${pathname}index.html`))) return serve(asset);
		if (
			(result = await redirectTo(
				`${pathname.slice(0, -"/".length)}.html`,
				pathname.slice(0, -"/".length),
			))
		) {
			return result;
		}
	} else if (pathname.endsWith(".html")) {
		if ((result = await redirectTo(pathname, pathname.slice(0, -".html".length)))) {
			return result;
		}
		if (
			(result = await redirectTo(
				`${pathname.slice(0, -".html".length)}/index.html`,
				`${pathname.slice(0, -".html".length)}/`,
			))
		) {
			return result;
		}
	}

	if (exact) return serve(exact);
	if ((asset = await exists(`${pathname}.html`))) return serve(asset);
	if ((result = await redirectTo(`${pathname}/index.html`, `${pathname}/`))) return result;
	return notFound(pathname, configuration, exists);
}

// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/asset-worker/src/handler.ts#L506-L675
async function htmlHandlingForceTrailingSlash(
	pathname: string,
	configuration: AssetHandlerConfiguration,
	exists: AssetLookup,
	skip: boolean,
): Promise<Intent> {
	const redirectTo = (file: string, destination: string): Promise<Intent> =>
		safeRedirect(file, destination, configuration, exists, skip);
	let result: Intent;
	let asset: AssetEntry | null;
	const exact = await exists(pathname);
	if (pathname.endsWith("/index")) {
		if (exact) return serve(exact);
		if ((result = await redirectTo(`${pathname}.html`, pathname.slice(0, -"index".length)))) {
			return result;
		}
		if (
			(result = await redirectTo(
				`${pathname.slice(0, -"/index".length)}.html`,
				pathname.slice(0, -"index".length),
			))
		) {
			return result;
		}
	} else if (pathname.endsWith("/index.html")) {
		if ((result = await redirectTo(pathname, pathname.slice(0, -"index.html".length)))) {
			return result;
		}
		if (
			(result = await redirectTo(
				`${pathname.slice(0, -"/index.html".length)}.html`,
				pathname.slice(0, -"index.html".length),
			))
		) {
			return result;
		}
	} else if (pathname.endsWith("/")) {
		if ((asset = await exists(`${pathname}index.html`))) return serve(asset);
		if ((asset = await exists(`${pathname.slice(0, -"/".length)}.html`))) return serve(asset);
	} else if (pathname.endsWith(".html")) {
		if ((result = await redirectTo(pathname, `${pathname.slice(0, -".html".length)}/`))) {
			return result;
		}
		// With both /foo.html and /foo/index.html, /foo.html stays at its own path.
		if (exact) return serve(exact);
		if (
			(result = await redirectTo(
				`${pathname.slice(0, -".html".length)}/index.html`,
				`${pathname.slice(0, -".html".length)}/`,
			))
		) {
			return result;
		}
	}

	if (exact) return serve(exact);
	if ((result = await redirectTo(`${pathname}.html`, `${pathname}/`))) return result;
	if ((result = await redirectTo(`${pathname}/index.html`, `${pathname}/`))) return result;
	return notFound(pathname, configuration, exists);
}

// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/asset-worker/src/handler.ts#L677-L879
async function htmlHandlingDropTrailingSlash(
	pathname: string,
	configuration: AssetHandlerConfiguration,
	exists: AssetLookup,
	skip: boolean,
): Promise<Intent> {
	const redirectTo = (file: string, destination: string): Promise<Intent> =>
		safeRedirect(file, destination, configuration, exists, skip);
	let result: Intent;
	let asset: AssetEntry | null;
	const exact = await exists(pathname);
	if (pathname.endsWith("/index")) {
		if (exact) return serve(exact);
		if (pathname === "/index") {
			if ((result = await redirectTo("/index.html", "/"))) return result;
		} else if (
			(result = await redirectTo(
				`${pathname.slice(0, -"/index".length)}.html`,
				pathname.slice(0, -"/index".length),
			))
		) {
			return result;
		} else if (
			(result = await redirectTo(`${pathname}.html`, pathname.slice(0, -"/index".length)))
		) {
			return result;
		}
	} else if (pathname.endsWith("/index.html")) {
		// The root keeps its slash.
		if (pathname === "/index.html") {
			if ((result = await redirectTo("/index.html", "/"))) return result;
		} else if (
			(result = await redirectTo(pathname, pathname.slice(0, -"/index.html".length)))
		) {
			return result;
		} else if (exact) {
			// With both /foo.html and /foo/index.html, /foo/index.html stays at its own path.
			return serve(exact);
		} else if (
			(result = await redirectTo(
				`${pathname.slice(0, -"/index.html".length)}.html`,
				pathname.slice(0, -"/index.html".length),
			))
		) {
			return result;
		}
	} else if (pathname.endsWith("/")) {
		if (pathname === "/") {
			if ((asset = await exists("/index.html"))) return serve(asset);
		} else if (
			(result = await redirectTo(
				`${pathname.slice(0, -"/".length)}.html`,
				pathname.slice(0, -"/".length),
			))
		) {
			return result;
		} else if (
			(result = await redirectTo(
				`${pathname.slice(0, -"/".length)}/index.html`,
				pathname.slice(0, -"/".length),
			))
		) {
			return result;
		}
	} else if (pathname.endsWith(".html")) {
		if ((result = await redirectTo(pathname, pathname.slice(0, -".html".length)))) {
			return result;
		}
		if (
			(result = await redirectTo(
				`${pathname.slice(0, -".html".length)}/index.html`,
				pathname.slice(0, -".html".length),
			))
		) {
			return result;
		}
	}

	if (exact) return serve(exact);
	if ((asset = await exists(`${pathname}.html`))) return serve(asset);
	if ((asset = await exists(`${pathname}/index.html`))) return serve(asset);
	return notFound(pathname, configuration, exists);
}

async function htmlHandlingNone(
	pathname: string,
	configuration: AssetHandlerConfiguration,
	exists: AssetLookup,
): Promise<Intent> {
	const exact = await exists(pathname);
	return exact ? serve(exact) : notFound(pathname, configuration, exists);
}

// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/asset-worker/src/handler.ts#L899-L937
async function notFound(
	pathname: string,
	configuration: AssetHandlerConfiguration,
	exists: AssetLookup,
): Promise<Intent> {
	switch (configuration.notFoundHandling) {
		case "single-page-application": {
			const asset = await exists("/index.html");
			return asset ? serve(asset) : null;
		}
		case "404-page": {
			// The nearest 404.html in this directory or a parent directory.
			let cwd = pathname;
			while (cwd) {
				cwd = cwd.slice(0, cwd.lastIndexOf("/"));
				const asset = await exists(`${cwd}/404.html`);
				if (asset) return serve(asset, 404);
			}
			return null;
		}
		case "none":
			return null;
	}
}

// Redirects to `destination` only when nothing exists there and it would
// serve the same file as `file`.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/asset-worker/src/handler.ts#L939-L971
async function safeRedirect(
	file: string,
	destination: string,
	configuration: AssetHandlerConfiguration,
	exists: AssetLookup,
	skip: boolean,
): Promise<Intent> {
	if (skip || (await exists(destination))) return null;
	const intent = await getIntent(destination, configuration, exists, true);
	if (intent?.asset && intent.asset.eTag === (await exists(file))?.eTag) {
		return { asset: null, redirect: destination };
	}
	return null;
}

// Paths are decoded before the lookup so that non-ASCII and optionally
// encoded characters match, then re-encoded to find the canonical path.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/asset-worker/src/handler.ts#L997-L1030
function decodePath(pathname: string): string {
	return pathname
		.split("/")
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join("/")
		.replace(/\/+/g, "/");
}

function encodePath(pathname: string): string {
	return pathname
		.split("/")
		.map((segment) => {
			try {
				return encodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join("/");
}
