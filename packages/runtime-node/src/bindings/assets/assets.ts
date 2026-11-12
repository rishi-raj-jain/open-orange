import {
	Request,
	type RequestInfo,
	type RequestInit,
	type Response,
} from "../../globals/http.js";
import { URL } from "../../globals/url.js";
import type { RuntimeAssetsConfiguration } from "../../process-protocol.js";
import { fetchFollowingRedirects } from "../service.js";
import { createAssetLookup, readAsset } from "./directory.js";
import {
	canFetch,
	handleRequest,
	type AssetHandlerConfiguration,
	type AssetLookup,
} from "./handler.js";

export interface Assets {
	// `env.ASSETS` for `assets.binding`.
	binding(): object;
	// The assets response for an inbound request, or undefined when the Worker
	// handles it.
	route(request: Request): Promise<Response | undefined>;
}

// A run_worker_first rule matches the whole path, and `*` matches anything.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/asset-worker/src/utils/rules-engine.ts#L31-L39
function staticRoutingMatcher(rules: readonly string[]): (pathname: string) => boolean {
	const patterns = rules.map(
		(rule) =>
			new RegExp(
				`^${rule
					.split("*")
					.map((part) => part.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"))
					.join(".*")}$`,
			),
	);
	return (pathname) => patterns.some((pattern) => pattern.test(pathname));
}

export function createAssets(configuration: RuntimeAssetsConfiguration): Assets {
	const exists: AssetLookup = createAssetLookup(configuration.directory);
	const handlerConfiguration: AssetHandlerConfiguration = {
		hasStaticRouting: configuration.staticRouting !== undefined,
		htmlHandling: configuration.htmlHandling,
		navigationPrefersAssetServing: configuration.navigationPrefersAssetServing,
		notFoundHandling: configuration.notFoundHandling,
	};
	const assetFirst = staticRoutingMatcher(configuration.staticRouting?.assetWorker ?? []);
	const workerFirst = staticRoutingMatcher(configuration.staticRouting?.userWorker ?? []);
	const serve = (request: Request): Promise<Response> =>
		handleRequest(request, handlerConfiguration, exists, readAsset);
	return {
		binding(): object {
			return Object.freeze({
				// Like any Fetcher, the binding follows redirects such as the 307 from
				// /page.html to /page.
				fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
					try {
						return fetchFollowingRedirects(new Request(input, init), serve);
					} catch (error: unknown) {
						return Promise.reject(error);
					}
				},
			});
		},
		// Static routing rules come first, then run_worker_first, then assets
		// when one matches the request, and the Worker last.
		// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/router-worker/src/worker.ts#L282-L345
		async route(request): Promise<Response | undefined> {
			const { pathname } = new URL(request.url);
			if (assetFirst(pathname)) return serve(request);
			if (workerFirst(pathname) || configuration.invokeUserWorkerAheadOfAssets) {
				return undefined;
			}
			if (
				configuration.hasUserWorker &&
				!(await canFetch(request, handlerConfiguration, exists))
			) {
				return undefined;
			}
			return serve(request);
		},
	};
}
