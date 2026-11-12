export default {
	async fetch(request, env) {
		try {
			const testCase = new URL(request.url).searchParams.get("case");
			if (testCase !== "shape") {
				throw new Error(`Unknown version metadata fixture case: ${testCase}`);
			}
			const metadata = env.VERSION_METADATA;
			return Response.json({
				type: "value",
				value: {
					extensible: Object.isExtensible(metadata),
					frozen: Object.isFrozen(metadata),
					id: metadata.id,
					keys: Object.keys(metadata),
					tag: metadata.tag,
					timestamp: metadata.timestamp,
					types: {
						id: typeof metadata.id,
						tag: typeof metadata.tag,
						timestamp: typeof metadata.timestamp,
					},
				},
			});
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
