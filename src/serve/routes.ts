// Matches requests to Workers by Wrangler `routes`, as Cloudflare does for one zone.
// A pattern is a host and a path. `*` may start the host and end the path. When more than
// one pattern matches, the most specific one wins.
// https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior

interface CompiledRoute<Target> {
	hostSuffix: string;
	hostWildcard: boolean;
	path: string;
	pathWildcard: boolean;
	pattern: string;
	target: Target;
}

export interface RouteTable<Target> {
	/** The target of the most specific matching route, or undefined. */
	match(host: string, path: string): Target | undefined;
}

export function compileRoutes<Target>(routes: readonly { pattern: string; target: Target }[]): RouteTable<Target> {
	const compiled = routes.map(({ pattern, target }) => compileRoute(pattern, target));
	// Exact hosts before wildcard hosts, then the longer host, then the longer path,
	// then an exact path before a path wildcard.
	compiled.sort(
		(left, right) =>
			Number(left.hostWildcard) - Number(right.hostWildcard) ||
			right.hostSuffix.length - left.hostSuffix.length ||
			right.path.length - left.path.length ||
			Number(left.pathWildcard) - Number(right.pathWildcard),
	);
	return {
		match(host, path) {
			const hostname = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
			return compiled.find((route) => routeMatches(route, hostname, path))?.target;
		},
	};
}

function compileRoute<Target>(pattern: string, target: Target): CompiledRoute<Target> {
	const withoutScheme = pattern.trim().replace(/^[a-z]+:\/\//i, "");
	const slash = withoutScheme.indexOf("/");
	const host = (slash === -1 ? withoutScheme : withoutScheme.slice(0, slash)).toLowerCase();
	const rawPath = slash === -1 ? "/" : withoutScheme.slice(slash);
	if (host.length === 0 || host.slice(1).includes("*") || rawPath.slice(0, -1).includes("*")) {
		throw new Error(
			`Route ${JSON.stringify(pattern)} is not valid. A route may use * only at the start of its host and the end of its path.`,
		);
	}
	const hostWildcard = host.startsWith("*");
	const pathWildcard = rawPath.endsWith("*");
	return {
		hostSuffix: hostWildcard ? host.slice(1) : host,
		hostWildcard,
		path: pathWildcard ? rawPath.slice(0, -1) : rawPath,
		pathWildcard,
		pattern,
		target,
	};
}

function routeMatches<Target>(route: CompiledRoute<Target>, hostname: string, path: string): boolean {
	const hostMatches = route.hostWildcard ? hostname.endsWith(route.hostSuffix) : hostname === route.hostSuffix;
	if (!hostMatches) return false;
	const pathname = path.replace(/[?#].*$/, "");
	return route.pathWildcard ? pathname.startsWith(route.path) : pathname === route.path;
}
