interface Env {
	RUNS: KVNamespace;
}

interface Run {
	count: number;
	cron: string;
	lastError?: string;
	lastOutcome: "exception" | "ok";
	scheduledTime: number;
}

type Job = (controller: ScheduledController, env: Env, ctx: ExecutionContext) => Promise<void>;

const jobs: Record<string, { job: Job; name: string }> = {
	"*/5 * * * *": {
		name: "heartbeat",
		// The job returns at once. The audit write runs after it in waitUntil(), and
		// the event still waits for it.
		async job(controller, env, ctx) {
			ctx.waitUntil(env.RUNS.put("audit:last-heartbeat", String(controller.scheduledTime)));
		},
	},
	"0 3 * * *": {
		name: "nightly-cleanup",
		// Deletes every temporary key, one page of the list at a time.
		async job(_controller, env) {
			let cursor: string | undefined;
			do {
				const page = await env.RUNS.list({ cursor, prefix: "tmp:" });
				await Promise.all(page.keys.map(({ name }) => env.RUNS.delete(name)));
				cursor = page.list_complete ? undefined : page.cursor;
			} while (cursor !== undefined);
		},
	},
	"0 18 LW * *": {
		name: "month-end-report",
		async job(controller, env) {
			const month = new Date(controller.scheduledTime).toISOString().slice(0, 7);
			const { keys } = await env.RUNS.list({ prefix: "run:" });
			await env.RUNS.put(`report:${month}`, JSON.stringify({ jobs: keys.length }));
		},
	},
	"0 9 * * 2#1": {
		name: "monthly-digest",
		// A rejected waitUntil() promise fails the event too.
		async job(controller, env, ctx) {
			ctx.waitUntil(
				(async () => {
					const subscribers = await env.RUNS.get("digest:subscribers");
					if (subscribers === null) throw new Error("No digest subscribers");
					await env.RUNS.put("digest:last-sent", String(controller.scheduledTime));
				})(),
			);
		},
	},
	"15 * * * *": {
		name: "upstream-sync",
		async job() {
			throw new Error("Upstream sync failed: https://upstream.example is unavailable");
		},
	},
};

async function record(env: Env, name: string, run: Omit<Run, "count">): Promise<void> {
	const previous = await env.RUNS.get<Run>(`run:${name}`, "json");
	await env.RUNS.put(`run:${name}`, JSON.stringify({ ...run, count: (previous?.count ?? 0) + 1 }));
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		// Temporary keys for the nightly cleanup to delete.
		if (url.pathname.startsWith("/tmp/") && request.method === "PUT") {
			await env.RUNS.put(`tmp:${url.pathname.slice("/tmp/".length)}`, await request.text());
			return new Response(null, { status: 204 });
		}
		if (url.pathname === "/tmp") {
			const { keys } = await env.RUNS.list({ prefix: "tmp:" });
			return Response.json({ keys: keys.map(({ name }) => name.slice("tmp:".length)) });
		}

		if (url.pathname === "/digest/subscribe" && request.method === "POST") {
			await env.RUNS.put("digest:subscribers", "1");
			return new Response(null, { status: 204 });
		}

		if (url.pathname === "/") {
			const { keys } = await env.RUNS.list({ prefix: "run:" });
			const runs = await Promise.all(
				keys.map(async ({ name }) => ({
					job: name.slice("run:".length),
					...(await env.RUNS.get<Run>(name, "json")),
				})),
			);
			const [lastHeartbeat, digestSentAt] = await Promise.all([
				env.RUNS.get("audit:last-heartbeat"),
				env.RUNS.get("digest:last-sent"),
			]);
			return Response.json({
				digestSentAt: digestSentAt === null ? null : Number(digestSentAt),
				lastHeartbeat: lastHeartbeat === null ? null : Number(lastHeartbeat),
				runs,
			});
		}

		return new Response("Not found. Try / or /tmp", { status: 404 });
	},

	async scheduled(controller, env, ctx): Promise<void> {
		const entry = jobs[controller.cron];
		if (entry === undefined) {
			// No later attempt can find a job for this cron, so do not retry it.
			controller.noRetry();
			throw new Error(`No job for cron ${JSON.stringify(controller.cron)}`);
		}
		const run = { cron: controller.cron, scheduledTime: controller.scheduledTime };
		try {
			await entry.job(controller, env, ctx);
		} catch (error) {
			await record(env, entry.name, {
				...run,
				lastError: error instanceof Error ? error.message : String(error),
				lastOutcome: "exception",
			});
			// Throw again so the Cron Trigger shows the failure.
			throw error;
		}
		await record(env, entry.name, { ...run, lastOutcome: "ok" });
	},
} satisfies ExportedHandler<Env>;
