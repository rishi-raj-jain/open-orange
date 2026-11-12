import { DurableObject } from "cloudflare:workers";
import {
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";

interface Env {
	OBJECT: DurableObjectNamespace<TmpObject>;
	OTHER: Fetcher;
}

function errorOf(run: () => unknown): unknown {
	try {
		run();
		return "no error";
	} catch (error: unknown) {
		return { code: Reflect.get(Object(error), "code"), message: Reflect.get(Object(error), "message") };
	}
}

// Module evaluation runs outside every request.
const globalScope = {
	entries: readdirSync("/tmp"),
	write: errorOf(() => writeFileSync("/tmp/global.txt", "global")),
	readBack: readFileSync("/tmp/global.txt", "utf8"),
};

// Lets a test hold one request open while another runs.
const signals = new Map<string, PromiseWithResolvers<void>>();

function signal(name: string): PromiseWithResolvers<void> {
	let entry = signals.get(name);
	if (entry === undefined) {
		entry = Promise.withResolvers<void>();
		signals.set(name, entry);
	}
	return entry;
}

export class TmpObject extends DurableObject {
	write(name: string): string[] {
		writeFileSync(`/tmp/${name}`, name);
		return readdirSync("/tmp").sort();
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const name = url.searchParams.get("name") ?? "file.txt";
		switch (url.pathname) {
			case "/global":
				return Response.json(globalScope);
			case "/write": {
				writeFileSync(`/tmp/${name}`, name);
				signal(name).resolve();
				const wait = url.searchParams.get("wait");
				if (wait !== null) await signal(wait).promise;
				return Response.json(readdirSync("/tmp").sort());
			}
			case "/wait":
				await signal(name).promise;
				return new Response("ready");
			case "/open":
				signal(name).resolve();
				return new Response("opened");
			case "/list":
				return Response.json(readdirSync("/tmp"));
			case "/other": {
				writeFileSync("/tmp/main.txt", "main");
				const other = await (await env.OTHER.fetch("http://other/")).json();
				return Response.json({ main: readdirSync("/tmp"), other });
			}
			case "/object":
				return Response.json(await env.OBJECT.getByName("tmp").write(name));
			default:
				return new Response("not found", { status: 404 });
		}
	},
};
