// The Worker runs inside the Orange runtime process, so it can write to the runtime's IPC
// channel the way a runtime from another build would. The bare `process` is Orange's
// workerd-like process, which has no IPC channel, so the fixture uses the global one.
const runtimeProcess = Reflect.get(globalThis, "process") as NodeJS.Process;

export default {
	fetch(request: Request): Response {
		if (new URL(request.url).pathname === "/invalid-ipc") {
			runtimeProcess.send?.({ type: "message-from-another-build" });
		}
		return new Response("ok");
	},
};
