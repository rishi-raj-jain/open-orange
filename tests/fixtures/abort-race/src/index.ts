import { DurableObject } from "cloudflare:workers";

interface Env {
	OBJ: DurableObjectNamespace<Obj>;
}

export class Obj extends DurableObject<Env> {
	ping(): string {
		return "pong";
	}

	write(value: number): number {
		this.ctx.storage.kv.put("last", value);
		return value;
	}

	boom(): never {
		this.ctx.abort("boom");
	}
}

// One round sends concurrent calls on fresh stubs while one call aborts the object, then one more
// call after they all settle. Calls that overlap the abort may fail with its error; the call after
// it must reach a new instance. Every other outcome is counted by its message.
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const rounds = Number(url.searchParams.get("rounds") ?? "20");
		const concurrency = 16;
		const outcomes: Record<string, number> = {};
		const note = (outcome: string): void => {
			outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
		};
		const classify = (error: unknown): string => {
			const message = String((error as Error)?.message ?? error);
			if (/boom/.test(message)) return "aborted";
			const cause = (error as Error)?.cause;
			return `error: ${message}${cause === undefined ? "" : ` (cause: ${String((cause as Error)?.stack ?? cause)})`}`;
		};
		for (let round = 0; round < rounds; round++) {
			const name = `object-${url.searchParams.get("tag") ?? ""}-${round % 3}`;
			const stub = (): DurableObjectStub<Obj> => env.OBJ.get(env.OBJ.idFromName(name));
			await Promise.all(
				Array.from({ length: concurrency }, (_, index) => {
					const call: Promise<unknown> =
						index === concurrency / 2 ? stub().boom() : index % 2 === 0 ? stub().write(index) : stub().ping();
					return call.then(
						() => note(index === concurrency / 2 ? "error: boom returned" : "ok"),
						(error: unknown) => note(classify(error)),
					);
				}),
			);
			try {
				await stub().ping();
				note("after abort: ok");
			} catch (error: unknown) {
				note(`after abort: ${classify(error)}`);
			}
		}
		return Response.json(outcomes);
	},
};
