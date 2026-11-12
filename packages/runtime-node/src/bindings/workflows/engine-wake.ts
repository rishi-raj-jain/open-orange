import type { DurableObjectState } from "../../modules/cloudflare-workers/durable-object.js";

// Cloudflare's open engine keeps its timers in the `priority_queue` table and waits for them in
// memory, so it relies on its Durable Object staying alive. `handleNextAlarm()` is a TODO for a
// waker in the production engine. Orange's engine objects sleep when idle, so the queue sets
// the object's alarm to its earliest timer, and the alarm restarts the engine, which replays
// the run and waits only for what is left.
// https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/lib/timePriorityQueue.ts#L143-L158
// While a run works, the alarm is also never later than this. A forced actor sleep, a crash, or
// an `orange dev` restart can stop the actor in the middle of a step, when the only timer is the
// step's timeout, 10 minutes away by default. The next generation then resumes the run soon.
export const workingWakeMs = 5_000;

const wakeFloors = new WeakMap<object, () => number | undefined>();

/** Registers when the engine of `state` must wake at the latest, besides its timers. */
export function registerWakeFloor(state: object, floor: () => number | undefined): void {
	wakeFloors.set(state, floor);
}

export function setWakeAlarm(state: DurableObjectState, timer: number | undefined): void {
	const floor = wakeFloors.get(state)?.();
	const earliest =
		floor === undefined ? timer : timer === undefined ? floor : Math.min(timer, floor);
	// A queue change of an engine that was aborted or stopped fails here, at once or later. Its
	// next generation sets the alarm again when the engine starts.
	let pending: Promise<void>;
	try {
		const storage = state.storage;
		pending = earliest === undefined ? storage.deleteAlarm() : storage.setAlarm(earliest);
	} catch {
		return;
	}
	pending.catch(() => undefined);
}
