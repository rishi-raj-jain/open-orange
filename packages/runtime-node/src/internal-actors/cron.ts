import { setTimeout as delay } from "node:timers/promises";

import type { ScheduledResult } from "../events/scheduled.js";
import {
	createRivetInternalActorDefinition,
	type RivetActorCron,
	type RivetActorHandle,
	type RivetInternalActorDefinition,
	unlimitedActionTimeoutMs,
} from "../internal/rivetkit.js";
import type { ScheduledEvent } from "../runtime.js";
import {
	cloudflareCronMatches,
	nextCloudflareCronTime,
	parseCloudflareCron,
	type CloudflareCron,
} from "./cron-expression.js";
import { isRecord } from "../bindings/unknown-values.js";

// One actor holds one Rivet cron job per `triggers.crons` expression. The job
// name is the expression as written, so it is also `controller.cron`. Orange
// evaluates the Cloudflare expression itself and gives Rivet only the next
// matching minute as a concrete `m h D M *` expression. Rivet's cron parser
// lacks `LW`, crosses month edges for `W`, and numbers weekdays from 0.
export const cronActorName = "openorange:cron";
export const cronActorKey: readonly string[] = ["cron"];

const syncAction = "sync";
const fireAction = "fire";

// Cloudflare does not run a tick it missed. Rivet runs the first missed tick
// once when the actor starts again, for example after `orange dev` was
// stopped, so the actor drops a fire that starts this late.
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-rust/packages/rivetkit-core/src/actor/schedule.rs#L660-L730
const missedTickAfterMs = 60_000;

export interface CronActorOptions {
	// The `triggers.crons` expressions of this process's Worker. Config loading
	// has already skipped, with a warning, each one that does not parse or never
	// matches a date.
	crons: readonly string[];
	runScheduled(event: ScheduledEvent): Promise<ScheduledResult>;
}

export interface CronJob {
	cron: string;
	nextRunAt: number;
}

// Points the job named `cron` at its next matching minute after `afterMs`.
// Setting the same minute again keeps the job's due time.
async function scheduleNextRun(
	jobs: RivetActorCron,
	cron: string,
	parsed: CloudflareCron,
	afterMs: number,
): Promise<number | undefined> {
	const next = nextCloudflareCronTime(parsed, afterMs);
	if (next === undefined) {
		await jobs.delete(cron);
		return undefined;
	}
	const date = new Date(next);
	await jobs.set({
		action: fireAction,
		args: [],
		expression: `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`,
		name: cron,
		timezone: "UTC",
	});
	return next;
}

function parseCronFire(args: unknown[]): {
	firedAt: number;
	name: string;
	scheduledAt: number;
} {
	const [fire] = args;
	if (
		args.length !== 1 ||
		!isRecord(fire) ||
		fire.kind !== "cron" ||
		typeof fire.name !== "string" ||
		typeof fire.scheduledAt !== "number" ||
		!Number.isSafeInteger(fire.scheduledAt) ||
		typeof fire.firedAt !== "number" ||
		!Number.isSafeInteger(fire.firedAt)
	) {
		throw new TypeError("RivetKit dispatched an invalid cron fire");
	}
	return { firedAt: fire.firedAt, name: fire.name, scheduledAt: fire.scheduledAt };
}

export function createCronActorDefinition(
	options: CronActorOptions,
): RivetInternalActorDefinition {
	const configured = new Map<string, CloudflareCron>(
		options.crons.map((cron) => [cron, parseCloudflareCron(cron)]),
	);
	return createRivetInternalActorDefinition({
		actions: {
			// Sets one job per expression and deletes every other job. Every
			// process can call this, because an unchanged job keeps its due time.
			[syncAction]: async (context, crons): Promise<CronJob[]> => {
				if (!Array.isArray(crons) || !crons.every((cron) => typeof cron === "string")) {
					throw new TypeError("Cron sync requires an array of expressions");
				}
				const jobs = context.cron;
				const now = Date.now();
				for (const cron of crons) {
					await scheduleNextRun(jobs, cron, parseCloudflareCron(cron), now);
				}
				const wanted = new Set<string>(crons);
				const synced: CronJob[] = [];
				for (const job of await jobs.list()) {
					if (!wanted.has(job.name)) await jobs.delete(job.name);
					else synced.push({ cron: job.name, nextRunAt: job.nextRunAt });
				}
				// A Worker without crons needs no cron actor. A later sync with crons
				// creates it again.
				if (synced.length === 0) context.destroy();
				return synced;
			},
			[fireAction]: async (context, ...args): Promise<void> => {
				const fire = parseCronFire(args);
				const jobs = context.cron;
				const parsed = configured.get(fire.name);
				// A job left by an earlier configuration that has not synced yet.
				if (parsed === undefined) {
					await jobs.delete(fire.name);
					return;
				}
				await scheduleNextRun(jobs, fire.name, parsed, Math.max(Date.now(), fire.scheduledAt));
				if (
					fire.firedAt - fire.scheduledAt > missedTickAfterMs ||
					!cloudflareCronMatches(parsed, fire.scheduledAt)
				) {
					return;
				}
				let result: ScheduledResult;
				try {
					result = await options.runScheduled({
						cron: fire.name,
						scheduledTime: fire.scheduledAt,
					});
				} finally {
					// Rivet skips a tick that arrives during this run and moves the
					// concrete job a year ahead, so point it at the next minute again.
					await scheduleNextRun(jobs, fire.name, parsed, Date.now());
				}
				// Throwing records the fire as failed in the actor's schedule.
				// Rivet does not retry it, and the next fire still runs.
				if (result.outcome !== "ok") {
					throw new Error(`scheduled() failed for cron trigger "${fire.name}"`);
				}
			},
		},
		// As a Durable Object's: with a cron every minute, Rivet's 30 s default keeps this actor awake half the time.
		options: { actionTimeout: unlimitedActionTimeoutMs, name: "Cron Triggers (Orange)", sleepTimeout: 10_000 },
	});
}

// Brings the cron actor's jobs in line with `crons` and returns each job's
// next run as Rivet stores it.
export async function syncCronTriggers(
	handle: RivetActorHandle,
	crons: readonly string[],
): Promise<CronJob[]> {
	const result = await handle.action({ args: [crons], name: syncAction });
	if (
		!Array.isArray(result) ||
		!result.every(
			(job): job is CronJob =>
				isRecord(job) && typeof job.cron === "string" && typeof job.nextRunAt === "number",
		)
	) {
		throw new Error("The cron actor returned an invalid sync result");
	}
	return result;
}

const backgroundSyncMaxDelayMs = 30_000;

// Against an external Engine, the sync fails while the Engine cannot reach the
// cron actor, for example while it still routes the actor to a runner that
// crashed. The Worker keeps serving meanwhile, so the sync retries with backoff
// and reports each failure until it succeeds or `signal` aborts.
export async function syncCronTriggersInBackground(
	sync: () => Promise<unknown>,
	signal: AbortSignal,
	reportFailure: (error: Error) => void,
): Promise<void> {
	for (let attempt = 0; !signal.aborted; attempt += 1) {
		try {
			await sync();
			return;
		} catch (error: unknown) {
			if (signal.aborted) return;
			const retryMs = Math.min(1_000 * 2 ** attempt, backgroundSyncMaxDelayMs);
			reportFailure(
				new Error(
					`Cron triggers are not synced with the Rivet Engine, so they do not fire yet. Retrying in ${retryMs / 1_000} s.`,
					{ cause: error },
				),
			);
			await delay(retryMs, undefined, { signal }).catch(() => undefined);
		}
	}
}
