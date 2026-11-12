export interface PortHandler {
	fetch(request: Request, env?: unknown, ctx?: unknown): Promise<Response>;
}

// Servers that called listen(), keyed by their virtual port.
export const portMapper = new Map<number, PortHandler>();

type ListenCallback = (...args: unknown[]) => unknown;

export function normalizeListenArgs(args: unknown[]): {
	port: unknown;
	callback: ListenCallback | undefined;
} {
	const last = args[args.length - 1];
	const callback: ListenCallback | undefined =
		typeof last === "function" ? (...values) => last(...values) : undefined;
	const first = args[0];
	if (typeof first === "object" && first !== null) {
		return { callback, port: "port" in first ? first.port : undefined };
	}
	return { callback, port: typeof first === "function" ? undefined : first };
}

export function findSuitablePort(port: number): number {
	if (port !== 0) return port;
	for (let i = 0; i < 10; i++) {
		const candidate = Math.floor(Math.random() * 65535) + 1;
		if (!portMapper.has(candidate)) return candidate;
	}
	throw new Error("Failed to find a suitable port after 10 attempts");
}
