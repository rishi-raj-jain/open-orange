// The runtime imports the Worker before it reports readiness. The bare `process` is Orange's
// workerd-like process, which has no IPC channel, so the fixture uses the global one.
(Reflect.get(globalThis, "process") as NodeJS.Process).send?.({ type: "message-from-another-build" });

export default {
	fetch(): Response {
		return new Response("ok");
	},
};
