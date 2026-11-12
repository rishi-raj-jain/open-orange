function languagesObservations() {
	const first = navigator.languages;
	const second = navigator.languages;
	let pushError = null;
	try {
		first.push("fr");
	} catch (error) {
		pushError = error instanceof Error ? error.name : String(error);
	}
	return {
		value: [...second],
		isArray: Array.isArray(first),
		frozen: Object.isFrozen(first),
		sameArray: first === second,
		pushError,
		afterPush: [...navigator.languages],
	};
}

export default {
	async fetch(request) {
		const testCase = new URL(request.url).searchParams.get("case");
		if (testCase !== "languages") {
			return Response.json({
				type: "error",
				error: { name: "Error", message: `Unknown navigator fixture case: ${testCase}` },
			});
		}
		return Response.json({ type: "value", value: languagesObservations() });
	},
};
