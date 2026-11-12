import { DurableObject } from "cloudflare:workers";

interface Env {
	THROWER: DurableObjectNamespace<Thrower>;
}

class FileError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "FileError";
		this.code = code;
	}
}

export class Thrower extends DurableObject<Env> {
	fail(): never {
		throw new FileError("no such file", "ENOENT");
	}

	make(): FileError {
		return new FileError("no such file", "ENOENT");
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const thrower = env.THROWER.getByName("thrower");
		if (new URL(request.url).pathname === "/returned") {
			const { code, message, name } = await thrower.make();
			return Response.json({ code, message, name });
		}
		try {
			await thrower.fail();
			return new Response("the call did not throw", { status: 500 });
		} catch (error) {
			const { code, message, name } = error as FileError;
			return Response.json({ code, message, name });
		}
	},
};
