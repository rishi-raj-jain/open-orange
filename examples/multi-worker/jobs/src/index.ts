import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

type Email = { subject: string; to: string };

interface Env {
	EMAILS: Queue<Email>;
	OUTBOX: KVNamespace;
}

// jobs consumes the emails queue and runs the signup Workflow. gateway only
// produces messages and starts instances.
export class SignupWorkflow extends WorkflowEntrypoint<Env, { email: string; user: string }> {
	async run(event: WorkflowEvent<{ email: string; user: string }>, step: WorkflowStep) {
		const { email, user } = event.payload;
		const account = await step.do("create account", async () => ({ createdAt: Date.now(), user }));
		await step.do("send welcome email", async () => {
			// A Worker can produce to a queue that it also consumes.
			await this.env.EMAILS.send({ subject: `Welcome, ${user}`, to: email });
		});
		return { user: account.user, welcomed: email };
	}
}

export default {
	// Reached from gateway through the dispatch namespace: /workers/jobs/emails.
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname !== "/emails") {
			return new Response(`jobs has no route ${pathname}`, { status: 404 });
		}
		const { keys } = await env.OUTBOX.list();
		const emails = await Promise.all(keys.map(async ({ name }) => JSON.parse((await env.OUTBOX.get(name)) ?? "null")));
		return Response.json({ emails });
	},

	async queue(batch, env): Promise<void> {
		for (const message of batch.messages) {
			const email = message.body as Email;
			if (batch.queue === "emails-failed") {
				await env.OUTBOX.put(`${message.id}`, JSON.stringify({ status: "bounced", to: email.to }));
				message.ack();
			} else if (email.to.endsWith("@bounce.test")) {
				// Fails every time, so it goes to emails-failed after max_retries.
				message.retry({ delaySeconds: 0 });
			} else {
				await env.OUTBOX.put(
					`${message.id}`,
					JSON.stringify({ attempts: message.attempts, status: "sent", subject: email.subject, to: email.to }),
				);
				message.ack();
			}
		}
	},
} satisfies ExportedHandler<Env>;
