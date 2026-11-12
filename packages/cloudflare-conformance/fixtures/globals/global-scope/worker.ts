function thrown(run) {
	try {
		run();
		return null;
	} catch (error) {
		return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	}
}

function workerGlobalScopeObservations() {
	return {
		type: typeof WorkerGlobalScope,
		name: WorkerGlobalScope.name,
		length: WorkerGlobalScope.length,
		construct: thrown(() => new WorkerGlobalScope()),
		selfIsInstance: self instanceof WorkerGlobalScope,
		objectIsInstance: {} instanceof WorkerGlobalScope,
		prototypeIsEventTarget: Object.getPrototypeOf(WorkerGlobalScope.prototype) === EventTarget.prototype,
		prototypeTag: Object.prototype.toString.call(WorkerGlobalScope.prototype),
		selfIsGlobal: self === globalThis,
		selfEventTarget: self.EventTarget === EventTarget,
	};
}

export default {
	async fetch(request) {
		const testCase = new URL(request.url).searchParams.get("case");
		if (testCase !== "worker-global-scope") {
			return Response.json({
				type: "error",
				error: { name: "Error", message: `Unknown global scope fixture case: ${testCase}` },
			});
		}
		return Response.json({ type: "value", value: workerGlobalScopeObservations() });
	},
};
