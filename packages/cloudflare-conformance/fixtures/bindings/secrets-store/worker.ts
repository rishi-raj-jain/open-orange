export default {
	async fetch(request, env) {
		try {
			const testCase = new URL(request.url).searchParams.get("case");
			const binding =
				testCase === "present"
					? env.PRESENT_SECRET
					: testCase === "missing"
						? env.MISSING_SECRET
						: undefined;
			if (binding === undefined) {
				throw new Error(`Unknown Secrets Store fixture case: ${testCase}`);
			}
			const value = await binding.get();
			return Response.json({ type: "value", value });
		} catch (error) {
			return Response.json({
				type: "error",
				error: {
					name: error instanceof Error ? error.name : "Error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	},
};
