import { createExecutionContext } from "../context.js";

export const eventContextFactories = {
	fetch: createExecutionContext,
	scheduled: createExecutionContext,
};
