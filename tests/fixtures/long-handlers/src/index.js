import { DurableObject } from "cloudflare:workers";

// Past RivetKit's default 60 second action timeout and the 10 seconds that an actor then waits
// before it sleeps.
const handlerMs = 90_000;
let firstRun = true;

export class AlarmRunner extends DurableObject {
	instance = crypto.randomUUID();

	async arm() {
		await this.ctx.storage.setAlarm(Date.now() + 100);
		return this.instance;
	}

	async alarm() {
		const log = this.env.LOG.getByName("log");
		await scheduler.wait(handlerMs);
		try {
			this.ctx.storage.kv.put("finished", this.instance);
			await log.record("alarm", "stored");
		} catch (error) {
			await log.record("alarm", String(error));
		}
	}

	status() {
		return { instance: this.instance, finished: this.ctx.storage.kv.get("finished") ?? null };
	}
}

// The test reads this object, not the handler's own. A request to the handler's object would keep
// it awake and hide the failure.
export class Log extends DurableObject {
	record(name, event) {
		this.ctx.storage.kv.put(name, [...this.read(name), event]);
	}

	read(name) {
		return this.ctx.storage.kv.get(name) ?? [];
	}
}

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		const runner = env.RUNNER.getByName("runner");
		if (pathname === "/arm") return Response.json(await runner.arm());
		if (pathname === "/status") return Response.json(await runner.status());
		return Response.json(await env.LOG.getByName("log").read(pathname.slice(1)));
	},

	async scheduled(controller, env) {
		const log = env.LOG.getByName("log");
		await log.record("cron", "start");
		// Only the first run is long, so no run is in flight when the test stops `orange dev`.
		if (firstRun) {
			firstRun = false;
			await scheduler.wait(handlerMs);
		}
		await log.record("cron", "end");
	},
};
