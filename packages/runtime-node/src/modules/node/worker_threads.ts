import nodeWorkerThreads from "node:worker_threads";

// A Worker's MessageChannel is Orange's global, and workerd's node:worker_threads exports the same
// class. Node's own would make channels that nothing else in a Worker accepts.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/worker_threads.ts#L42
export * from "node:worker_threads";

const orangeGlobal = (name: "MessageChannel" | "MessagePort"): unknown => Reflect.get(globalThis, name);

export const MessageChannel = orangeGlobal("MessageChannel");
export const MessagePort = orangeGlobal("MessagePort");

// workerd reads nothing here: a port's messages only arrive through its events.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/worker_threads.ts#L152
export function receiveMessageOnPort(_port: unknown): undefined {
	return undefined;
}

export default { ...nodeWorkerThreads, MessageChannel, MessagePort, receiveMessageOnPort };
