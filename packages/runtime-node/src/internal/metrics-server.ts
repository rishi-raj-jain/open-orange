import { createServer } from "node:http";

// A Rivet cluster scrapes each runner's Prometheus metrics from 127.0.0.1:$RIVETKIT_METRICS_PORT.
// RivetKit renders them but leaves serving them to the app, so `orange serve` serves them here,
// apart from the Worker's own port.
export const metricsPortVariable = "RIVETKIT_METRICS_PORT";

export interface MetricsServer {
	close(): Promise<void>;
}

/** Parses RIVETKIT_METRICS_PORT. Undefined when it is unset. */
export function metricsPortFromEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): number | undefined {
	const value = environment[metricsPortVariable];
	if (value === undefined || value.length === 0) return undefined;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`${metricsPortVariable} must be a TCP port; received ${JSON.stringify(value)}`);
	}
	return port;
}

export async function startMetricsServer(
	port: number,
	metrics: () => Promise<Response>,
): Promise<MetricsServer> {
	const server = createServer((incoming, outgoing) => {
		const pathname = (incoming.url ?? "/").split("?", 1)[0];
		if (incoming.method !== "GET" || pathname !== "/metrics") {
			outgoing.writeHead(404).end();
			return;
		}
		void (async () => {
			try {
				const response = await metrics();
				outgoing.statusCode = response.status;
				response.headers.forEach((value, name) => outgoing.setHeader(name, value));
				outgoing.end(Buffer.from(await response.arrayBuffer()));
			} catch (error: unknown) {
				outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				outgoing.end(`metrics failed: ${error instanceof Error ? error.message : String(error)}\n`);
			}
		})();
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	return {
		close: () =>
			new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => {
					if (error === undefined) {
						resolveClose();
					} else {
						rejectClose(error);
					}
				});
			}),
	};
}
