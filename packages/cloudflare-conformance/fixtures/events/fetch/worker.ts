interface Env {
	MESSAGE: string;
}

const worker: ExportedHandler<Env> = {
	async fetch(request, env, context) {
		context.waitUntil(Promise.resolve());
		return Response.json({
			message: env.MESSAGE,
			method: request.method,
		});
	},
};

export default worker;
