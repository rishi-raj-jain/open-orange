interface Env {
	EVENTS: Queue;
	JOBS: Queue<Job>;
	RESULTS: KVNamespace;
}

interface Job {
	// Seconds to wait before the first delivery.
	delaySeconds?: number;
	// The job fails on each attempt up to this number, then succeeds.
	failUntilAttempt?: number;
	id: string;
	sentAt: number;
}

interface JobResult {
	attempts?: number;
	status: "done" | "failed";
	waitedMs: number;
}

class BadRequest extends Error {}

// send() and sendBatch() throw for an invalid delay, content type, or body.
async function enqueue(send: () => Promise<unknown>): Promise<void> {
	try {
		await send();
	} catch (error) {
		throw new BadRequest(error instanceof Error ? error.message : String(error));
	}
}

function readJob(value: unknown): Job {
	const job = value as Partial<Job> | null;
	if (typeof job?.id !== "string") {
		throw new BadRequest('Send JSON like {"id":"a","failUntilAttempt":1,"delaySeconds":2}');
	}
	return {
		delaySeconds: job.delaySeconds,
		failUntilAttempt: job.failUntilAttempt,
		id: job.id,
		sentAt: Date.now(),
	};
}

async function list<T>(env: Env, prefix: string): Promise<(T & { id: string })[]> {
	const { keys } = await env.RESULTS.list({ prefix });
	return Promise.all(
		keys.map(async ({ name }) => ({
			id: name.slice(prefix.length),
			...(await env.RESULTS.get<T>(name, "json"))!,
		})),
	);
}

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const body = () => request.json().catch(() => null);

	switch (`${request.method} ${url.pathname}`) {
		case "POST /jobs": {
			const job = readJob(await body());
			await enqueue(() => env.JOBS.send(job, { delaySeconds: job.delaySeconds }));
			return Response.json({ queued: job.id }, { status: 202 });
		}
		case "POST /jobs/batch": {
			// Each message can set its own delay. The batch delay covers the rest.
			const { delaySeconds, jobs } = ((await body()) ?? {}) as {
				delaySeconds?: number;
				jobs?: unknown[];
			};
			const parsed = (Array.isArray(jobs) ? jobs : []).map(readJob);
			await enqueue(() =>
				env.JOBS.sendBatch(
					parsed.map((job) => ({ body: job, delaySeconds: job.delaySeconds })),
					{ delaySeconds },
				),
			);
			return Response.json({ queued: parsed.map((job) => job.id) }, { status: 202 });
		}
		case "GET /jobs": {
			const maxBatchSize = await env.RESULTS.get("stats:max-batch-size");
			return Response.json({
				maxBatchSize: Number(maxBatchSize ?? 0),
				results: await list<JobResult>(env, "job:"),
			});
		}
		case "POST /events": {
			// contentType decides how the consumer sees the body: "text" gives a
			// string, "bytes" an ArrayBuffer, and "json" (the default) a structured copy.
			const contentType = url.searchParams.get("contentType") ?? "json";
			const message =
				contentType === "text"
					? await request.text()
					: contentType === "bytes"
						? new Uint8Array(await request.arrayBuffer())
						: await body();
			await enqueue(() =>
				env.EVENTS.send(message, { contentType: contentType as QueueContentType }),
			);
			return new Response(null, { status: 202 });
		}
		case "GET /events":
			return Response.json({ events: await list(env, "event:") });
		case "GET /metrics": {
			// Backlog metrics are a newer Queues API, so check for it first.
			const queue = env.JOBS as Queue<Job> & { metrics?: () => Promise<unknown> };
			if (typeof queue.metrics !== "function") {
				return Response.json({ error: "This runtime has no Queue.metrics()" }, { status: 501 });
			}
			return Response.json(await queue.metrics());
		}
		default:
			return new Response("Not found. Try /jobs or /events", { status: 404 });
	}
}

async function consumeJobs(batch: MessageBatch<Job>, env: Env): Promise<void> {
	const previous = Number((await env.RESULTS.get("stats:max-batch-size")) ?? 0);
	if (batch.messages.length > previous) {
		await env.RESULTS.put("stats:max-batch-size", String(batch.messages.length));
	}
	for (const message of batch.messages) {
		const job = message.body;
		if (message.attempts <= (job.failUntilAttempt ?? 0)) {
			// Back off longer after each failure.
			message.retry({ delaySeconds: message.attempts });
			continue;
		}
		const result: JobResult = {
			attempts: message.attempts,
			status: "done",
			waitedMs: Date.now() - job.sentAt,
		};
		await env.RESULTS.put(`job:${job.id}`, JSON.stringify(result));
		message.ack();
	}
}

async function consumeEvents(batch: MessageBatch, env: Env): Promise<void> {
	// One flaky event on its first attempt sends the whole batch back.
	const flaky = batch.messages.some(
		(message) =>
			message.attempts === 1 && (message.body as { kind?: string } | null)?.kind === "flaky",
	);
	if (flaky) {
		batch.retryAll({ delaySeconds: 1 });
		return;
	}
	await Promise.all(
		batch.messages.map((message) => {
			const body = message.body;
			const event =
				typeof body === "string"
					? { type: "text", value: body }
					: body instanceof ArrayBuffer || ArrayBuffer.isView(body)
						? { type: "bytes", value: [...new Uint8Array(ArrayBuffer.isView(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : body)] }
						: { type: "json", value: body };
			return env.RESULTS.put(
				`event:${message.timestamp.getTime()}-${message.id}`,
				JSON.stringify({ ...event, attempts: message.attempts }),
			);
		}),
	);
	batch.ackAll();
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await route(request, env);
		} catch (error) {
			if (error instanceof BadRequest) {
				return Response.json({ error: error.message }, { status: 400 });
			}
			throw error;
		}
	},

	async queue(batch, env): Promise<void> {
		switch (batch.queue) {
			case "jobs":
				return consumeJobs(batch as MessageBatch<Job>, env);
			case "events":
				return consumeEvents(batch, env);
			case "jobs-failed":
				// Each job that ran out of retries arrives here as a new message.
				for (const message of (batch as MessageBatch<Job>).messages) {
					const job = message.body;
					const result: JobResult = { status: "failed", waitedMs: Date.now() - job.sentAt };
					await env.RESULTS.put(`job:${job.id}`, JSON.stringify(result));
				}
				batch.ackAll();
				return;
			default:
				throw new Error(`No consumer for queue ${batch.queue}`);
		}
	},
} satisfies ExportedHandler<Env>;
