// OPEN-ORANGE PATCH: only the storage keys remain. The modifier class serves the
// vitest-pool-workers introspection API, which Orange does not offer.

// KV key prefixes/values used by the modifier/mock system
export const MODIFIER_KEYS = {
	REPLACE_RESULT: "replace-result-",
	MOCK_STEP_ERROR: "mock-step-error-",
	MOCK_EVENT: "mock-event-",
	FORCE_STEP_TIMEOUT: "force-step-timeout-",
	FORCE_EVENT_TIMEOUT: "force-event-timeout-",
	FAILURE_INDEX: "failure-index-",
	DISABLE_SLEEP: "disable-sleep-",
	DISABLE_ALL_SLEEPS: "disableAllSleeps",
	DISABLE_RETRY_DELAY: "disable-retry-delay-",
	DISABLE_ALL_RETRY_DELAYS: "disableAllRetryDelays",
} as const;

export function isModifierKey(key: string): boolean {
	return Object.values(MODIFIER_KEYS).some((v) => key.startsWith(v));
}
