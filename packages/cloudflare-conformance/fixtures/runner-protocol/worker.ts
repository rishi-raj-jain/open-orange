function errorOutcome(error) {
	return {
		type: "error",
		error: {
			name: error instanceof Error ? error.name : "Error",
			message: error instanceof Error ? error.message : String(error),
		},
	};
}

export default {
	async fetch(request) {
		try {
			const testCase = new URL(request.url).searchParams.get("case");
			if (testCase === "globals") {
				const globalNames = new Set();
				let current = globalThis;
				while (current !== null) {
					for (const name of Reflect.ownKeys(current)) {
						if (typeof name === "string") {
							globalNames.add(name);
						}
					}
					current = Object.getPrototypeOf(current);
				}
				return Response.json({
					type: "value",
					value: [...globalNames].sort(),
				});
			}
			if (testCase === "error") {
				throw new TypeError("runner protocol failure");
			}
			return Response.json({
				type: "value",
				value: {
					array: [true, null, 42],
					message: "runner protocol ready",
				},
			});
		} catch (error) {
			return Response.json(errorOutcome(error));
		}
	},
};
