// What a tail() handler can see of one TraceItem, as JSON.
export function summarize(item) {
	const request = item.event.request;
	const unredacted = request.getUnredacted();
	return {
		path: new URL(unredacted.url).pathname,
		url: request.url,
		unredactedUrl: unredacted.url,
		method: request.method,
		authorization: request.headers.authorization,
		unredactedAuthorization: unredacted.headers.authorization,
		hasCf: typeof request.cf === "object",
		status: item.event.response?.status ?? null,
		outcome: item.outcome,
		scriptName: item.scriptName,
		executionModel: item.executionModel,
		truncated: item.truncated,
		timestampIsNumber: typeof item.eventTimestamp === "number",
		logs: item.logs.map((log) => ({
			level: log.level,
			message: log.message,
			errorInfo:
				log.errorInfo?.map((info) =>
					info === null
						? null
						: { name: info.name, message: info.message, stackHasFrames: info.stack.includes("at ") },
				) ?? null,
		})),
		exceptions: item.exceptions.map((exception) => ({
			name: exception.name,
			message: exception.message,
			stackHasFrames: exception.stack.includes("at "),
		})),
	};
}
