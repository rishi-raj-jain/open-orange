const durableObjectAbortErrors = new WeakMap<
	Error,
	{ readonly retryAlarm: boolean }
>();

export function createDurableObjectAbortError(
	reason: string | undefined,
	retryAlarm: boolean,
): Error {
	const error = new Error(
		reason ?? "Application called abort() to reset Durable Object.",
	);
	durableObjectAbortErrors.set(error, { retryAlarm });
	return error;
}

export function durableObjectAbortRetriesAlarm(error: unknown): boolean | undefined {
	return error instanceof Error
		? durableObjectAbortErrors.get(error)?.retryAlarm
		: undefined;
}
