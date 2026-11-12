import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

interface Env {
	ORDERS: Workflow<Order>;
}

interface Order {
	item: string;
	quantity: number;
	// "flaky" fails the first two payment attempts. "declined" fails for good.
	card?: "declined" | "flaky" | "ok";
	// How long to wait for a manager's decision before the order is cancelled.
	approvalTimeout?: WorkflowSleepDuration;
}

interface Approval {
	approved: boolean;
	by: string;
}

const stock: Readonly<Record<string, number>> = { book: 10, lamp: 2 };

export class OrderWorkflow extends WorkflowEntrypoint<Env, Order> {
	async run(event: WorkflowEvent<Order>, step: WorkflowStep) {
		const { item, quantity } = event.payload;

		// A failure that a retry cannot fix stops the Workflow at once.
		const reservation = await step.do("reserve stock", async () => {
			const available = stock[item] ?? 0;
			if (quantity > available) {
				throw new NonRetryableError(`Only ${available} ${item} in stock`);
			}
			return { item, quantity };
		});

		// Retries with exponential backoff: 3 retries, 200 ms, then 400 ms, then 800 ms.
		// A step's return value is stored, so a replay never charges twice.
		const charge = await step.do(
			"charge card",
			{ retries: { backoff: "exponential", delay: 200, limit: 3 }, timeout: "10 seconds" },
			async (ctx) => {
				if (event.payload.card === "declined") {
					throw new NonRetryableError("Card declined");
				}
				if (event.payload.card === "flaky" && ctx.attempt < 3) {
					throw new Error(`Payment gateway timed out on attempt ${ctx.attempt}`);
				}
				return { attempts: ctx.attempt, chargeId: `ch_${event.instanceId}` };
			},
		);

		await step.sleep("let the payment settle", "1 second");

		// Values that change between runs, like the time, belong in a step so a
		// replay sees the same value.
		const dispatchAt = await step.do("pick dispatch time", async () => Date.now() + 1000);
		await step.sleepUntil("wait for the dispatch window", dispatchAt);

		let approval: Approval;
		try {
			const decision = await step.waitForEvent<Approval>("manager decision", {
				timeout: event.payload.approvalTimeout ?? "1 hour",
				type: "decision",
			});
			approval = decision.payload;
		} catch (error: unknown) {
			// Only handle the timeout. Other errors must reach the engine.
			if (!(error instanceof Error && error.name === "WorkflowTimeoutError")) throw error;
			const refund = await step.do("refund", async () => `refunded ${charge.chargeId}`);
			return { refund, reservation, result: "cancelled: no decision in time" };
		}

		if (!approval.approved) {
			const refund = await step.do("refund", async () => `refunded ${charge.chargeId}`);
			return { refund, reservation, result: `rejected by ${approval.by}` };
		}
		const tracking = await step.do("ship", async () => `track_${event.instanceId}`);
		return { approvedBy: approval.by, charge, reservation, result: "shipped", tracking };
	}
}

function errorBody(error: unknown): { error: string; name: string } {
	return error instanceof Error
		? { error: error.message, name: error.name }
		: { error: String(error), name: "Error" };
}

function parseOrder(value: unknown): { id?: string; params: Order } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { id, item, quantity, card, approvalTimeout } = value as Record<string, unknown>;
	if (typeof item !== "string" || typeof quantity !== "number") return undefined;
	const params: Order = { item, quantity };
	if (card === "declined" || card === "flaky" || card === "ok") params.card = card;
	if (typeof approvalTimeout === "string" || typeof approvalTimeout === "number") {
		params.approvalTimeout = approvalTimeout as WorkflowSleepDuration;
	}
	return typeof id === "string" ? { id, params } : { params };
}

const orderHint = 'Send JSON like {"id":"order-1","item":"book","quantity":1}';

async function createOrders(request: Request, env: Env, batch: boolean): Promise<Response> {
	const body: unknown = await request.json().catch(() => undefined);
	const orders = batch && Array.isArray(body) ? body.map(parseOrder) : [parseOrder(body)];
	if (orders.length === 0 || orders.some((order) => order === undefined)) {
		return Response.json({ error: batch ? `Send an array. ${orderHint}` : orderHint }, { status: 400 });
	}
	const options = orders as { id?: string; params: Order }[];
	try {
		// Without an id, Workflows picks a random UUID.
		const instances = batch
			? await env.ORDERS.createBatch(options)
			: [await env.ORDERS.create(options[0])];
		return Response.json({ ids: instances.map((instance) => instance.id) }, { status: 201 });
	} catch (error: unknown) {
		// A taken id and an invalid id both reject the create.
		const taken = error instanceof Error && error.message.includes("instance.already_exists");
		return Response.json(errorBody(error), { status: taken ? 409 : 400 });
	}
}

// Pause, resume, terminate, and restart are part of the Cloudflare API.
const lifecycleActions = new Set(["pause", "resume", "terminate", "restart"]);

async function orderAction(
	request: Request,
	instance: WorkflowInstance,
	action: string | undefined,
	url: URL,
): Promise<Response> {
	if (request.method === "GET" && action === undefined) {
		// `output` is set once the instance is complete, and `error` once it has errored.
		return Response.json({ id: instance.id, ...(await instance.status()) });
	}
	if (request.method === "POST" && (action === "approve" || action === "reject")) {
		const by = url.searchParams.get("by") ?? "a manager";
		// An event sent before the Workflow waits for it stays queued until then.
		await instance.sendEvent({ payload: { approved: action === "approve", by }, type: "decision" });
		return Response.json({ sent: action }, { status: 202 });
	}
	if (request.method === "POST" && action !== undefined && lifecycleActions.has(action)) {
		try {
			if (action === "pause") await instance.pause();
			else if (action === "resume") await instance.resume();
			else if (action === "terminate") await instance.terminate();
			else await instance.restart();
			return Response.json({ done: action });
		} catch (error: unknown) {
			// A call that does not fit the instance's status fails, for example
			// terminate() on an instance that already finished.
			return Response.json(errorBody(error), { status: 409 });
		}
	}
	return Response.json({ error: "Unknown order route" }, { status: 404 });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const [, collection, id, action] = url.pathname.split("/");
		if (collection !== "orders") {
			return Response.json({ error: "Try POST /orders or GET /orders/<id>" }, { status: 404 });
		}
		if (request.method === "POST" && (id === undefined || id === "")) {
			return await createOrders(request, env, false);
		}
		if (request.method === "POST" && id === "batch" && action === undefined) {
			return await createOrders(request, env, true);
		}
		if (id === undefined || id === "") {
			return Response.json({ error: "Add an order id" }, { status: 404 });
		}

		let instance: WorkflowInstance;
		try {
			instance = await env.ORDERS.get(id);
		} catch {
			return Response.json({ error: `No order ${id}` }, { status: 404 });
		}
		return await orderAction(request, instance, action, url);
	},
} satisfies ExportedHandler<Env>;
