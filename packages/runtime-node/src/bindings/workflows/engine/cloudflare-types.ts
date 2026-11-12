// OPEN-ORANGE: the vendored engine was written against `@cloudflare/workers-types`
// globals. These are the declarations it uses, taken from workerd's type
// definitions and narrowed to what the engine touches, so the vendored files
// change only their import lines.
// https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/types/defines/rpc.d.ts#L296-L420
// https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/types/defines/workflows.d.ts#L104-L200

import type { DurableObjectId } from "../../durable-objects/id.js";

export type {
	DurableObjectState,
	DurableObjectStorage,
} from "../../../modules/cloudflare-workers/durable-object.js";

export type WorkflowDurationLabel =
	| "second"
	| "minute"
	| "hour"
	| "day"
	| "week"
	| "month"
	| "year";

export type WorkflowSleepDuration =
	| `${number} ${WorkflowDurationLabel}${"s" | ""}`
	| number;

export type WorkflowDelayDuration = WorkflowSleepDuration;

export type WorkflowTimeoutDuration = WorkflowSleepDuration;

export type WorkflowBackoff = "constant" | "linear" | "exponential";

export type WorkflowStepSensitivity = "output";

export type WorkflowStepContext = {
	step: { name: string; count: number };
	attempt: number;
	config: unknown;
};

export type WorkflowDynamicDelayContext = {
	ctx: WorkflowStepContext;
	error: Error;
};

export type WorkflowDelayFunction = (
	input: WorkflowDynamicDelayContext,
) => WorkflowDelayDuration | Promise<WorkflowDelayDuration>;

export type WorkflowStepConfig = {
	retries?: {
		limit: number;
		delay: WorkflowDelayDuration | number | WorkflowDelayFunction;
		backoff?: WorkflowBackoff;
	};
	timeout?: WorkflowTimeoutDuration | number;
	sensitive?: WorkflowStepSensitivity;
};

export type WorkflowEvent<T> = {
	payload: Readonly<T>;
	timestamp: Date;
	instanceId: string;
	workflowName?: string;
};

export type WorkflowStepEvent<T> = {
	payload: Readonly<T>;
	timestamp: Date;
	type: string;
};

// The engine calls only `run`. The step argument is the engine's own Context.
export interface WorkflowEntrypoint {
	run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<unknown>;
}

export type WorkflowStep = object;

export interface DurableObjectNamespace<T> {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): T;
}

export interface Fetcher {
	fetch(input: string, init?: RequestInit): Promise<Response>;
}

// workerd's `Rpc.Serializable<T>`. Values cross Orange's RPC as plain data.
export declare namespace Rpc {
	type Serializable<T> = T;
}

export interface RestartFromStep {
	name: string;
	count?: number;
	type?: "do" | "sleep" | "waitForEvent";
}

export interface WorkflowInstanceTerminateOptions {
	rollback?: boolean;
}

export type { ReadableStreamReadResult } from "node:stream/web";
