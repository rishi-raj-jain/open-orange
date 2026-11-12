
import { ms } from "itty-time";
import { z } from "zod";

import type { DurableObjectNamespace } from "../durable-objects/namespace.js";
import {
	createWorkflowError,
	isUserTriggeredDelete,
	isUserTriggeredPause,
	isUserTriggeredRestart,
	isUserTriggeredTerminate,
	WorkflowError,
} from "./engine/lib/errors";
import {
	isValidAddressableWorkflowInstanceId,
	isValidWorkflowInstanceId,
} from "./engine/lib/validators";
import type { RestartFromStep, WorkflowInstanceTerminateOptions } from "./engine/cloudflare-types";
import {
	type WorkflowEngineObject,
	type WorkflowInstanceStatusResult,
	workflowEngineObjectName,
} from "./engine-object.js";
import { serializeUnshared } from "../../internal/v8-serialize.js";

// `env.WORKFLOW`: a port of Cloudflare's local Workflow binding onto Orange's Durable Object
// namespace of engine objects, shaped like workerd's `cloudflare-internal:workflows-api` wrapper.
// https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/binding.ts#L268-L935
// https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/src/cloudflare/internal/workflows-api.ts#L52-L174

export interface WorkflowBindingOptions {
	// The configured Workflow `name`. Bindings with the same name share instances.
	name: string;
	// The engine objects of the Worker that runs the Workflow.
	namespace(): DurableObjectNamespace<WorkflowEngineObject>;
}

interface WorkflowCreateOptions {
	id?: string;
	locationHint?: string;
	params?: unknown;
	retention?: { errorRetention?: unknown; successRetention?: unknown };
}

type WorkflowBatchCreateOptions =
	| { count: number; locationHint?: string; params?: unknown; retention?: WorkflowCreateOptions["retention"] }
	| { instances: WorkflowCreateOptions[] };

interface WorkflowBatchCreateResult {
	created: WorkflowInstance[];
	errors: { code: number; id?: string; index: number; message: string }[];
}

interface WorkflowBatchDeleteResult {
	deleted: { id: string }[];
	errors: { code: number; id: string; message: string }[];
}

// Errors from the engine object reach Worker code with their names, as workerd's RPC keeps them
// for compatibility dates from 2026-04-21 (`enhanced_error_serialization`).
// https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/binding.ts#L221-L265
const retentionDurationSchema = z.union([z.number(), z.string()]).refine(
	(value) => {
		if (typeof value === "number") return Number.isInteger(value) && value > 0;
		try {
			const duration = ms(value);
			return Number.isFinite(duration) && duration > 0;
		} catch {
			return false;
		}
	},
	{
		message:
			"Duration must be a number or a string in format '{{number}} {{unit}}' where unit is second(s), minute(s), etc.",
	},
);

const workflowInstanceCreateOptionsSchema = z.object({
	id: z.string().optional(),
	locationHint: z
		.enum(["wnam", "weur", "enam", "eeur", "apac", "apac-ne", "apac-se", "oc", "sam", "afr", "me"])
		.optional(),
	params: z.any().optional(),
	retention: z
		.object({
			errorRetention: retentionDurationSchema.optional(),
			successRetention: retentionDurationSchema.optional(),
		})
		.optional(),
});

export class WorkflowInstance {
	readonly id: string;
	readonly #engine: () => ReturnType<DurableObjectNamespace<WorkflowEngineObject>["get"]>;

	constructor(id: string, engine: () => ReturnType<DurableObjectNamespace<WorkflowEngineObject>["get"]>) {
		this.id = id;
		this.#engine = engine;
	}

	// https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/binding.ts#L805-L859
	async pause(): Promise<void> {
		try {
			await this.#engine().changeInstanceStatus("pause");
		} catch (error: unknown) {
			if (!isUserTriggeredPause(error)) throw error;
		}
	}

	async resume(): Promise<void> {
		await this.#engine().changeInstanceStatus("resume");
	}

	async terminate(options?: WorkflowInstanceTerminateOptions): Promise<void> {
		try {
			await this.#engine().changeInstanceStatus("terminate", undefined, options);
		} catch (error: unknown) {
			if (!isUserTriggeredTerminate(error)) throw error;
		}
	}

	async delete(): Promise<void> {
		try {
			await this.#engine().deleteInstance();
		} catch (error: unknown) {
			if (!isUserTriggeredDelete(error)) throw error;
		}
	}

	async restart(options?: { from?: RestartFromStep }): Promise<void> {
		try {
			await this.#engine().changeInstanceStatus("restart", options?.from);
		} catch (error: unknown) {
			if (!isUserTriggeredRestart(error)) throw error;
		}
		// The restart aborted the object, and its next generation wipes the steps and runs again.
		await this.#engine().attemptRestart();
	}

	async status(): Promise<WorkflowInstanceStatusResult> {
		return await this.#engine().readStatus();
	}

	async sendEvent(event: { payload?: unknown; type: string }): Promise<void> {
		await this.#engine().sendEvent(event.type, serializeUnshared(event.payload));
	}
}

export class Workflow {
	readonly #options: WorkflowBindingOptions;

	constructor(options: WorkflowBindingOptions) {
		this.#options = options;
	}

	// Each call gets its own stub. A Durable Object stub breaks after one failed call, and the
	// engine aborts its object on pause, terminate, restart, and delete.
	#engine(id: string): ReturnType<DurableObjectNamespace<WorkflowEngineObject>["get"]> {
		const namespace = this.#options.namespace();
		return namespace.get(namespace.idFromName(workflowEngineObjectName(this.#options.name, id)));
	}

	#instance(id: string): WorkflowInstance {
		return new WorkflowInstance(id, () => this.#engine(id));
	}

	// https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/binding.ts#L280-L367
	async create(options: WorkflowCreateOptions = {}): Promise<WorkflowInstance> {
		const { id = crypto.randomUUID() } = options;
		if (!isValidWorkflowInstanceId(id)) {
			throw new WorkflowError("Workflow instance has invalid id");
		}
		await this.#create(id, options);
		return this.#instance(id);
	}

	// Params cross Orange's RPC as V8 serialization, so they keep structured-clone types.
	async #create(id: string, options: WorkflowCreateOptions): Promise<void> {
		const { params = {} } = options;
		const bytes = serializeUnshared(params);
		await this.#engine(id).create(id, this.#options.name, bytes, Date.now());
	}

	async #createIfAbsent(id: string, options: WorkflowCreateOptions): Promise<boolean> {
		try {
			await this.#create(id, options);
			return true;
		} catch (error: unknown) {
			if (error instanceof Error && error.message.includes("(instance.already_exists)")) {
				return false;
			}
			throw error;
		}
	}

	// https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/binding.ts#L369-L385
	async get(id: string): Promise<WorkflowInstance> {
		const instance = this.#instance(id);
		try {
			await instance.status();
		} catch {
			throw new Error("instance.not_found");
		}
		return instance;
	}

	// https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/binding.ts#L438-L581
	async createBatch(batch: WorkflowCreateOptions[]): Promise<WorkflowInstance[]>;
	async createBatch(options: WorkflowBatchCreateOptions): Promise<WorkflowBatchCreateResult>;
	async createBatch(
		options: WorkflowCreateOptions[] | WorkflowBatchCreateOptions,
	): Promise<WorkflowInstance[] | WorkflowBatchCreateResult> {
		const isLegacyBatch = Array.isArray(options);
		let batch: WorkflowCreateOptions[];
		if (isLegacyBatch) {
			batch = options;
		} else if (options !== null && typeof options === "object") {
			if ("count" in options && options.count !== undefined) {
				if (!Number.isInteger(options.count) || options.count <= 0) {
					throw createWorkflowError("count must be a positive integer", "body");
				}
				batch = Array.from({ length: options.count }, () => ({
					locationHint: options.locationHint,
					params: options.params,
					retention: options.retention,
				}));
			} else if ("instances" in options && Array.isArray(options.instances)) {
				batch = options.instances;
			} else {
				throw createWorkflowError("Provided argument is invalid", "body");
			}
		} else {
			throw createWorkflowError("Provided argument is invalid", "body");
		}

		if (batch.length === 0) {
			if (!isLegacyBatch) throw createWorkflowError("Batch size exceeds maximum allowed", "body");
			throw new Error("WorkflowError: batchCreate should have at least 1 instance");
		}
		// Cloudflare creates at most 100 instances per batch, a quota that Orange does not copy.

		for (const instanceOptions of batch) {
			if (!isLegacyBatch) {
				const validation = workflowInstanceCreateOptionsSchema.safeParse(instanceOptions);
				if (!validation.success) {
					throw createWorkflowError(
						validation.error.issues.map((issue) => issue.message).join("; "),
						"body",
					);
				}
			}
			if (
				instanceOptions.id !== undefined &&
				(!isValidWorkflowInstanceId(instanceOptions.id) ||
					(!isLegacyBatch &&
						(["batch", "terminate", "terminateAll"].includes(instanceOptions.id) ||
							/^cf_[0-9a-f]{64}$/.test(instanceOptions.id))))
			) {
				if (isLegacyBatch) throw new WorkflowError("Workflow instance has invalid id");
				throw createWorkflowError("Instance ID is invalid", "instance.invalid_id");
			}
		}

		// Cloudflare probes the existing IDs first. Orange's engine object rejects a taken ID
		// when it creates the instance, so the probe and the create are one step.
		const created: string[] = [];
		const errors: WorkflowBatchCreateResult["errors"] = [];
		const seenIds = new Set<string>();
		for (const [index, instanceOptions] of batch.entries()) {
			if (instanceOptions.id !== undefined) {
				if (seenIds.has(instanceOptions.id)) {
					if (!isLegacyBatch) {
						errors.push({
							code: 10415,
							id: instanceOptions.id,
							index,
							message: "workflows.api.error.instance.duplicate_in_batch",
						});
					}
					continue;
				}
				seenIds.add(instanceOptions.id);
			}
			const { id = crypto.randomUUID() } = instanceOptions;
			if (await this.#createIfAbsent(id, instanceOptions)) {
				created.push(id);
			} else if (!isLegacyBatch) {
				errors.push({
					code: 10405,
					id,
					index,
					message: "workflows.api.error.instance.already_exists",
				});
			}
		}
		const instances = created.map((id) => this.#instance(id));
		return isLegacyBatch ? instances : { created: instances, errors };
	}

	// https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/binding.ts#L587-L694
	async #deleteInstance(id: string): Promise<void> {
		if (!isValidAddressableWorkflowInstanceId(id)) {
			throw createWorkflowError("Instance ID is invalid", "instance.invalid_id");
		}
		try {
			await this.#engine(id).deleteInstance();
		} catch (error: unknown) {
			if (!isUserTriggeredDelete(error)) throw error;
		}
	}

	async deleteBatch(instanceIds: string[]): Promise<WorkflowBatchDeleteResult> {
		if (!Array.isArray(instanceIds)) {
			throw createWorkflowError("Provided argument is invalid", "body");
		}
		if (instanceIds.length === 0) {
			throw createWorkflowError("batchDeleteInstances should have at least 1 instance", "body");
		}
		if (!instanceIds.every(isValidAddressableWorkflowInstanceId)) {
			throw createWorkflowError("Instance ID is invalid", "instance.invalid_id");
		}
		const uniqueIds = [...new Set(instanceIds)];
		const settled = await Promise.allSettled(uniqueIds.map((id) => this.#deleteInstance(id)));
		const resultsById = new Map(uniqueIds.map((id, index) => [id, settled[index]]));
		const result: WorkflowBatchDeleteResult = { deleted: [], errors: [] };
		for (const id of instanceIds) {
			const deletion = resultsById.get(id);
			if (deletion === undefined) throw new Error("Missing batch deletion result");
			if (deletion.status === "fulfilled") {
				result.deleted.push({ id });
				continue;
			}
			const isNotFound =
				deletion.reason instanceof Error &&
				deletion.reason.message.includes("(instance.not_found)");
			result.errors.push({
				code: isNotFound ? 10400 : 10001,
				id,
				message: isNotFound
					? "workflows.api.error.instance.not_found"
					: "workflows.api.error.internal_server",
			});
		}
		return result;
	}
}
