import { randomBytes } from "node:crypto";

// Virtual hosts from ctx.mapVirtualHost(). A fetcher keeps the first host it
// gets, and cloudflare:sockets connect() to that host goes through the fetcher.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L2306-L2329

const hostsByFetcher = new WeakMap<object, string>();
const fetchersByHost = new Map<string, WeakRef<object>>();
const forgetHost = new FinalizationRegistry<string>((host) => {
	fetchersByHost.delete(host);
});

export function mapVirtualHost(fetcher: object, port: number): string {
	let host = hostsByFetcher.get(fetcher);
	if (host === undefined) {
		host = `${randomBytes(16).toString("hex")}.workers.alt:${Number(port)}`;
		hostsByFetcher.set(fetcher, host);
		fetchersByHost.set(host, new WeakRef(fetcher));
		forgetHost.register(fetcher, host);
	}
	return host;
}

export function virtualHostFetcher(address: string): object | undefined {
	return fetchersByHost.get(address)?.deref();
}
