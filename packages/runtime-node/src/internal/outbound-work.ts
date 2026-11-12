import { calledByWorker } from "./worker-caller.js";
import { currentWorkerTmp } from "./worker-tmp.js";

/** Work that an object started and that is not an event of the object. */
export type OutboundWork = "fetch" | "outbound-websocket";

/** Learns when outbound work starts in an owner's scope. The returned function runs when it ends. */
export type OutboundWorkObserver = (work: OutboundWork) => () => void;

// Keyed by the /tmp scope that the code runs in, which is one Durable Object instance.
const observers = new WeakMap<object, OutboundWorkObserver>();

/** Calls `observer` for each piece of outbound work that code in the scope of `owner` starts. */
export function observeOutboundWork(owner: object, observer: OutboundWorkObserver): void {
	observers.set(owner, observer);
}

/** Tells the object that runs the calling code about outbound work. The result ends the work. */
export function startOutboundWork(work: OutboundWork): (() => void) | undefined {
	const owner = currentWorkerTmp();
	return owner === undefined ? undefined : observers.get(owner)?.(work);
}

/** Like startOutboundWork(), for work that only counts when Worker code called `api` to start it. */
export function startWorkerOutboundWork(api: Function, work: OutboundWork): (() => void) | undefined {
	const owner = currentWorkerTmp();
	const observer = owner === undefined ? undefined : observers.get(owner);
	// Only an object's scope has an observer, so other code skips the look at the call stack.
	return observer !== undefined && calledByWorker(api) ? observer(work) : undefined;
}
