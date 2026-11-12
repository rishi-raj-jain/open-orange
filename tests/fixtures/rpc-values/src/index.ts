import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

class Thing extends RpcTarget {
	ping(value: string): string {
		return `pong ${value}`;
	}

	child(): Thing {
		return new Thing();
	}
}

export class Maker extends WorkerEntrypoint {
	async makeThing(): Promise<Thing> {
		return new Thing();
	}
}

interface Env {
	VALUES: DurableObjectNamespace<Values>;
}

const largeBlobBytes = 8 * 1024 * 1024;

function largeBlob(): Blob {
	const bytes = new Uint8Array(largeBlobBytes);
	for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31) % 251;
	return new Blob([bytes], { type: "application/octet-stream" });
}

async function describeBlob(blob: unknown): Promise<unknown> {
	if (!(blob instanceof Blob)) return { notABlob: Object.prototype.toString.call(blob) };
	const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
	return {
		sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
		size: blob.size,
		type: blob.type,
	};
}

function unsupportedValue(kind: string): unknown {
	const file = new File(["contents"], "notes.txt", { lastModified: 5, type: "text/plain" });
	if (kind === "file") return file;
	const form = new FormData();
	form.append("note", file);
	return form;
}

export class Values extends DurableObject<Env> {
	// Returns a stub this object got from a WorkerEntrypoint.
	async thingFromEntrypoint() {
		return await (this.ctx.exports as unknown as { Maker: Maker }).Maker.makeThing();
	}

	echo(value: unknown): unknown {
		return value;
	}

	describeBlob(blob: unknown): Promise<unknown> {
		return describeBlob(blob);
	}

	largeBlob(): Blob {
		return largeBlob();
	}

	mixed(): unknown {
		return {
			domException: new DOMException("missing", "NotFoundError"),
			networkError: Response.error(),
			number: new Number(3),
			typed: new Blob([new Uint8Array([0, 255, 7])], { type: "application/x-bytes" }),
		};
	}

	unsupported(kind: string): unknown {
		return unsupportedValue(kind);
	}
}

async function describeMixed(value: unknown): Promise<unknown> {
	const { domException, networkError, number, typed } = value as Record<string, unknown>;
	return {
		domException:
			domException instanceof DOMException
				? { code: domException.code, message: domException.message, name: domException.name }
				: String(domException),
		networkError:
			networkError instanceof Response
				? { status: networkError.status, type: networkError.type }
				: String(networkError),
		number: number instanceof Number ? number.valueOf() : String(number),
		typed:
			typed instanceof Blob
				? { bytes: [...new Uint8Array(await typed.arrayBuffer())], type: typed.type }
				: String(typed),
	};
}

async function failure(call: () => Promise<unknown>): Promise<unknown> {
	try {
		await call();
		return "the call did not throw";
	} catch (error) {
		const { message, name } = error as Error;
		return { message, name };
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const path = new URL(request.url).pathname;
		const values = () => env.VALUES.getByName(crypto.randomUUID());
		if (path === "/entrypoint-stub") {
			const thing = (await values().thingFromEntrypoint()) as unknown as Thing;
			const child = await thing.child();
			return Response.json({ direct: await thing.ping("a"), child: await child.ping("b") });
		}
		if (path === "/large-blob") {
			const sent = largeBlob();
			return Response.json({
				expected: await describeBlob(sent),
				received: await values().describeBlob(sent),
				returned: await describeBlob(await values().largeBlob()),
			});
		}
		if (path === "/mixed") {
			const stub = values();
			const returned = await stub.mixed();
			return Response.json({
				echoed: await describeMixed(await stub.echo(returned)),
				returned: await describeMixed(returned),
			});
		}
		if (path === "/unsupported") {
			return Response.json({
				returnedFile: await failure(() => values().unsupported("file")),
				sentFile: await failure(() => values().echo(unsupportedValue("file"))),
				sentFormData: await failure(() => values().echo(unsupportedValue("form-data"))),
			});
		}
		return new Response("not found", { status: 404 });
	},
};
