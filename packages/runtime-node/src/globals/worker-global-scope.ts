import { NodeEventTarget } from "./node-web.js";
import { markWorkerdClass } from "./workerd-class.js";

// workerd exposes WorkerGlobalScope as an interface object that Worker code
// cannot construct. Its prototype inherits from EventTarget.prototype. Worker
// code gets false from `self instanceof WorkerGlobalScope` on workerd too, so
// Orange's Node global object gives the same answer.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.h
export abstract class WorkerGlobalScope extends NodeEventTarget {
	declare readonly EventTarget: typeof EventTarget;

	constructor() {
		super();
		throw new TypeError("Illegal constructor");
	}
}

markWorkerdClass(WorkerGlobalScope, "WorkerGlobalScope");
