import { DurableObject, RpcTarget } from "cloudflare:workers";

class Session extends RpcTarget {
	name() {
		return "session";
	}
}

export class Log extends DurableObject {
	boot = crypto.randomUUID();

	// The delay lets the calling event end while the call is in flight.
	async record(key) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		await this.ctx.storage.put(key, "ran");
		return { key };
	}

	async fail(key) {
		await this.record(key);
		throw new Error("failed in the object");
	}

	async session(key) {
		await this.record(key);
		return new Session();
	}

	async read() {
		return { boot: this.boot, keys: [...(await this.ctx.storage.list()).keys()].sort() };
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const log = env.LOG.getByName(url.searchParams.get("log") ?? "log");
		const key = url.searchParams.get("key");
		const report = {
			then: (value) => console.log(`continuation ran: ${JSON.stringify(value)}`),
			catch: (error) => console.log(`continuation ran: ${error.message}`),
		};
		switch (url.pathname) {
			case "/bare":
				log.record(key);
				break;
			case "/observed":
				log.record(key).then(report.then, report.catch);
				break;
			case "/failing":
				log.fail(key).then(report.then, report.catch);
				break;
			case "/chained":
				log.record(`${key}-first`).then(() => log.record(`${key}-second`)).catch(report.catch);
				break;
			case "/session":
				log.session(key).then(report.then, report.catch);
				break;
			default:
				return Response.json(await log.read());
		}
		return new Response("sent");
	},
};
