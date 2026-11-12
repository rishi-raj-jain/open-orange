import { clearTimeout, setTimeout } from "node:timers";

const defaultIdleTimeoutMilliseconds = 10_000;
const maximumReportIntervalMilliseconds = 600_000;

/** What keeps an idle object from hibernating. */
export type HibernationHold =
	| "event"
	| "fetch"
	| "keep-awake"
	| "outbound-websocket"
	| "rpc-result"
	| "rpc-session"
	| "standard-websocket"
	| "timer"
	| "unclaimed-upgrade"
	| "wait-until";

/** A pending timer of the object. */
export interface HibernationTimer {
	delayMilliseconds: number;
	repeat: boolean;
}

/** Why an object that had no event for `idleMilliseconds` still runs. */
export interface HibernationHeldReport {
	holds: ReadonlyMap<HibernationHold, number>;
	idleMilliseconds: number;
	/** The pending timers by kind, such as `setInterval(3000ms)`, with their counts. */
	timers: ReadonlyMap<string, number>;
}

export type HibernationHeldReporter = (report: HibernationHeldReport) => void;

// Rivet's idle detector currently treats even hibernatable raw connections as
// active connections, so its ordinary sleepTimeout never fires for this case.
// Keep the Cloudflare ten-second inactivity rule actor-local, then use Rivet's
// explicit sleep request to enter its normal persisted hibernation lifecycle.
// https://github.com/cloudflare/workerd/blob/5f8e6964ddf897da379f4030499d21ffcf492da0/src/workerd/server/server.c%2B%2B#L988-L1013
// https://github.com/rivet-dev/actors/blob/3848076c011ad2f881bca9821e4d5c725aa9f15e/rivetkit-rust/packages/rivetkit-core/src/actor/sleep.rs#L246-L271
export class DurableObjectHibernationLifecycle {
	readonly #holds = new Map<HibernationHold, number>();
	readonly #idleTimeoutMilliseconds: number;
	// Each pending timer's kind, as `delay * 2 + repeat`, with its count.
	readonly #timers = new Map<number, number>();
	#holdCount = 0;
	#lastEventAt = Date.now();
	#report: HibernationHeldReporter | undefined;
	// The next report is due once the object has had no event for this long.
	#reportAtIdleMilliseconds: number;
	#reportTimer: ReturnType<typeof setTimeout> | undefined;
	#reportTimerDueAt = 0;
	#requestSleep: (() => void) | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(idleTimeoutMilliseconds = defaultIdleTimeoutMilliseconds) {
		if (
			!Number.isFinite(idleTimeoutMilliseconds) ||
			idleTimeoutMilliseconds <= 0
		) {
			throw new RangeError("Hibernation idle timeout must be positive");
		}
		this.#idleTimeoutMilliseconds = idleTimeoutMilliseconds;
		this.#reportAtIdleMilliseconds = idleTimeoutMilliseconds;
	}

	/**
	 * Starts the idle timeout. With `report`, the object also reports what holds it each time it
	 * passes the idle timeout without hibernating, at a doubling interval. Without it, no report
	 * timer runs.
	 */
	bind(requestSleep: () => void, report?: HibernationHeldReporter): void {
		this.#requestSleep = requestSleep;
		this.#report = report;
		this.#scheduleReport(this.#idleTimeoutMilliseconds);
		this.eventSettled();
	}

	/** An event of the object ended, so its idle time starts again. */
	eventSettled(): void {
		this.#eventActivity();
		this.#restartIdleTimer();
	}

	preventSleepUntil(lifetime: Promise<unknown>, reason: HibernationHold): void {
		const release = this.hold(reason);
		void lifetime.then(release, release);
	}

	/** Prevents sleep until the returned function runs. Running it again does nothing. */
	hold(reason: HibernationHold): () => void {
		// A report during a long event counts the idle time from the event's start.
		if (reason === "event") this.#eventActivity();
		this.#holds.set(reason, (this.#holds.get(reason) ?? 0) + 1);
		this.#holdCount++;
		this.#clearTimer();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#holds.set(reason, (this.#holds.get(reason) ?? 1) - 1);
			this.#holdCount--;
			if (reason === "event") this.eventSettled();
			else this.#restartIdleTimer();
		};
	}

	/** Prevents sleep while the timer is pending. */
	holdTimer(timer: HibernationTimer): () => void {
		const kind = timer.delayMilliseconds * 2 + (timer.repeat ? 1 : 0);
		this.#timers.set(kind, (this.#timers.get(kind) ?? 0) + 1);
		const release = this.hold("timer");
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const count = (this.#timers.get(kind) ?? 1) - 1;
			if (count === 0) this.#timers.delete(kind);
			else this.#timers.set(kind, count);
			release();
		};
	}

	/**
	 * The idle timeout passed, and `blockers` kept the object from hibernating. Reports them, and
	 * waits for the idle timeout again.
	 */
	blocked(blockers: ReadonlyMap<HibernationHold, number>): void {
		if ([...blockers.values()].some((count) => count > 0)) {
			this.#report?.({
				holds: blockers,
				idleMilliseconds: Date.now() - this.#lastEventAt,
				timers: new Map(),
			});
		}
		this.#restartIdleTimer();
	}

	eventTimedOut(): void {
		this.#clearTimer();
		this.#requestSleep?.();
	}

	dispose(): void {
		this.#clearTimer();
		clearTimeout(this.#reportTimer);
		this.#reportTimer = undefined;
		this.#report = undefined;
		this.#requestSleep = undefined;
	}

	#restartIdleTimer(): void {
		if (this.#requestSleep === undefined || this.#holdCount > 0) return;
		this.#clearTimer();
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#requestSleep?.();
		}, this.#idleTimeoutMilliseconds);
	}

	#clearTimer(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	// An event starts or ends, so the idle time and the report sequence start again.
	#eventActivity(): void {
		this.#lastEventAt = Date.now();
		this.#reportAtIdleMilliseconds = this.#idleTimeoutMilliseconds;
		// One timer serves every report. A timer due before the next report finds the new due time
		// when it runs, so only a timer due later, after the interval grew, starts again.
		if (this.#reportTimerDueAt > this.#lastEventAt + this.#idleTimeoutMilliseconds) {
			this.#scheduleReport(this.#idleTimeoutMilliseconds);
		}
	}

	#scheduleReport(delayMilliseconds: number): void {
		if (this.#report === undefined) return;
		clearTimeout(this.#reportTimer);
		this.#reportTimerDueAt = Date.now() + delayMilliseconds;
		this.#reportTimer = setTimeout(() => this.#reportHeld(), delayMilliseconds);
		this.#reportTimer.unref();
	}

	#reportHeld(): void {
		const idleMilliseconds = Date.now() - this.#lastEventAt;
		if (idleMilliseconds < this.#reportAtIdleMilliseconds) {
			this.#scheduleReport(this.#reportAtIdleMilliseconds - idleMilliseconds);
			return;
		}
		// Without a hold, the idle timer runs, and the object hibernates or reports its blockers.
		if (this.#holdCount > 0) {
			this.#report?.({
				holds: new Map([...this.#holds].filter(([, count]) => count > 0)),
				idleMilliseconds,
				timers: new Map(
					[...this.#timers].map(([kind, count]) => [
						`${kind % 2 === 1 ? "setInterval" : "setTimeout"}(${Math.floor(kind / 2)}ms)`,
						count,
					]),
				),
			});
		}
		const interval = Math.min(this.#reportAtIdleMilliseconds, maximumReportIntervalMilliseconds);
		this.#reportAtIdleMilliseconds += interval;
		this.#scheduleReport(interval);
	}
}
