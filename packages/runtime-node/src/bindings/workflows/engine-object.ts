import { deserialize } from "node:v8";

import { createExecutionContext, runInExecutionContext } from "../../context.js";
import { reportError } from "../../globals/global-scope.js";
import { internalObjectLifetime, type InternalObjectLifetime } from "../durable-objects/state.js";
import { serializeStoredValue } from "../durable-objects/sync-kv.js";
import type {
	DurableObjectState,
	DurableObjectStorage,
} from "../../modules/cloudflare-workers/durable-object.js";
import { DurableObject } from "../../modules/cloudflare-workers/index.js";
import type {
	RestartFromStep,
	WorkflowEntrypoint,
	WorkflowEvent,
	WorkflowInstanceTerminateOptions,
} from "./engine/cloudflare-types";
import { Engine } from "./engine/engine";
import type { DatabaseInstance, DatabaseVersion, DatabaseWorkflow } from "./engine/engine";
import {
	INSTANCE_METADATA,
	InstanceEvent,
	InstanceStatus,
	instanceStatusName,
	InstanceTrigger,
	type InstanceMetadata,
} from "./engine/instance";
import {
	ABORT_REASONS,
	duplicateInstanceError,
	isAbortError,
	isUserTriggeredRestart,
} from "./engine/lib/errors";
import { registerWakeFloor, workingWakeMs } from "./engine-wake.js";

// One Durable Object per Workflow instance runs Cloudflare's Workflows engine, the same engine
// that `wrangler dev` runs. Its ID is `idFromName(JSON.stringify([workflowName, instanceId]))`
// in the namespace of this class, so every Workflow of the Worker shares the class.
export const workflowEngineClassName = "openorange:workflow-engine";

// The engine's status key in storage.
// https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/engine.ts#L141
const engineStatusKey = "ENGINE_STATUS";

export function workflowEngineObjectName(workflowName: string, instanceId: string): string {
	return JSON.stringify([workflowName, instanceId]);
}

export interface WorkflowEngineHost {
	// Workflow class names by Workflow name.
	readonly classNames: ReadonlyMap<string, string>;
	// `ctx.exports` for the Workflow's execution context.
	readonly contextExports: object;
	// The Worker's named exports.
	readonly workerExports: Readonly<Record<string, unknown>>;
}

let engineHost: WorkflowEngineHost | undefined;

// The runner sets the Worker's Workflow classes before any engine object starts.
export function configureWorkflowEngines(host: WorkflowEngineHost): void {
	engineHost = host;
}

function requireEngineHost(): WorkflowEngineHost {
	if (engineHost === undefined) {
		throw new Error("This Worker runtime has no Workflows configured");
	}
	return engineHost;
}

export interface WorkflowInstanceStatusResult {
	error?: { message: string; name: string };
	output: unknown;
	status: string;
}

// Counts the step calls in flight, so the engine object knows when its run only waits.
interface RunActivity {
	enter(kind: "parked" | "working"): () => void;
}

interface EngineStep {
	do(name: string, ...rest: unknown[]): Promise<unknown>;
	sleep(name: string, duration: unknown): Promise<void>;
	sleepUntil(name: string, timestamp: unknown): Promise<void>;
	waitForEvent(name: string, options: unknown): Promise<unknown>;
}

// The `step` argument of `run()`. Errors keep their names, as workerd's RPC keeps them for
// compatibility dates from 2026-04-21 (`enhanced_error_serialization`).
function workflowStep(context: EngineStep, activity: RunActivity): object {
	const track = async <Result>(
		kind: "parked" | "working",
		operation: () => Promise<Result>,
	): Promise<Result> => {
		const leave = activity.enter(kind);
		try {
			return await operation();
		} finally {
			leave();
		}
	};
	return {
		do: (name: string, ...rest: unknown[]) =>
			track("working", () => context.do(name, ...rest)),
		sleep: (name: string, duration: unknown) =>
			track("parked", () => context.sleep(name, duration)),
		sleepUntil: (name: string, timestamp: unknown) =>
			track("parked", () => context.sleepUntil(name, timestamp)),
		waitForEvent: (name: string, options: unknown) =>
			track("parked", () => context.waitForEvent(name, options)),
	};
}

function isEngineStep(value: unknown): value is EngineStep {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "do") === "function" &&
		typeof Reflect.get(value, "sleep") === "function" &&
		typeof Reflect.get(value, "sleepUntil") === "function" &&
		typeof Reflect.get(value, "waitForEvent") === "function"
	);
}

async function runWorkflowClass(
	environment: Record<string, unknown>,
	event: WorkflowEvent<unknown>,
	step: object,
): Promise<unknown> {
	const host = requireEngineHost();
	const workflowName = event.workflowName ?? "";
	const className = host.classNames.get(workflowName);
	const workflowClass = className === undefined ? undefined : host.workerExports[className];
	if (typeof workflowClass !== "function") {
		throw new Error(
			`Workflow ${JSON.stringify(workflowName)} needs the class ${JSON.stringify(className)}, which this Worker does not export`,
		);
	}
	const controller = createExecutionContext({ exports: host.contextExports, props: undefined });
	try {
		return await runInExecutionContext(controller.context, async () => {
			const instance: unknown = Reflect.construct(workflowClass, [
				controller.context,
				environment,
			]);
			const run: unknown =
				typeof instance === "object" && instance !== null
					? Reflect.get(instance, "run")
					: undefined;
			if (typeof run !== "function") {
				throw new TypeError(`Workflow class ${className} has no run() method`);
			}
			return await Reflect.apply(run, instance, [event, step]);
		});
	} finally {
		void controller.drainWaitUntil().then(() => controller.end());
	}
}

// Set when an engine is aborted. Its storage view then fails every call with the abort reason,
// like the storage of an aborted workerd object, so a run it left behind cannot write.
interface EngineFence {
	aborted: Error | undefined;
}

// The engine's view of its object's state.
// - The engine uses `storage.transaction()` only to order its status writes, while its run keeps
//   writing log rows with synchronous SQL. Orange's storage rejects synchronous SQL from other
//   work while an asynchronous transaction is open, which workerd allows. So the engine's
//   transactions run one at a time, in call order, on the implicit transaction instead.
//   https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/engine.ts#L1740-L1766
// - Every storage call checks the fence.
function engineState(state: DurableObjectState, fence: EngineFence): DurableObjectState {
	const checked = <Value>(value: Value): Value => {
		if (fence.aborted !== undefined) throw fence.aborted;
		return value;
	};
	const sql = new Proxy(state.storage.sql, {
		get(target, property, receiver): unknown {
			const value: unknown = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => Reflect.apply(value, target, checked(args));
		},
	});
	let tail: Promise<unknown> = Promise.resolve();
	const storage = new Proxy(state.storage, {
		get(target, property, receiver): unknown {
			if (property === "sql") return sql;
			if (property === "transaction") {
				return <Result>(closure: (transaction: DurableObjectStorage) => Promise<Result>) => {
					const result = tail.then(() => closure(checked(storage)));
					tail = result.catch(() => undefined);
					return result;
				};
			}
			const value: unknown = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => Reflect.apply(value, target, checked(args));
		},
	});
	return new Proxy(state, {
		get(target, property, receiver): unknown {
			if (property === "storage") return storage;
			if (property === "blockConcurrencyWhile") {
				return <Result>(callback: () => Promise<Result>) =>
					target.blockConcurrencyWhile(async () => {
						checked(undefined);
						return await callback();
					});
			}
			return Reflect.get(target, property, receiver);
		},
	});
}

/**
 * Cloudflare's engine with the Orange parts: it runs the Worker's Workflow class in this process,
 * it keeps the actor awake while its run works, and an abort replaces it in place.
 */
class OrangeEngine extends Engine {
	readonly #environment: Record<string, unknown>;
	readonly #fence: EngineFence;
	readonly #lifetime: InternalObjectLifetime;
	readonly #replace: () => void;
	#parked = 0;
	#releaseAwake: (() => void) | undefined;
	#runs = 0;
	#working = 0;

	constructor(
		state: DurableObjectState,
		environment: Record<string, unknown>,
		lifetime: InternalObjectLifetime,
		replace: () => void,
	) {
		const fence: EngineFence = { aborted: undefined };
		// The engine reads its own bindings, such as STEP_LIMIT, from env. The Worker's env goes
		// only to the Workflow class.
		super(
			engineState(state, fence),
			// SAFETY: The engine reads only the optional STEP_LIMIT, STEP_LIMITS, and WORKFLOW_NAME
			// of env. It reads USER_WORKFLOW only in workflowTarget(), which this class overrides.
			{} as ConstructorParameters<typeof Engine>[1],
		);
		this.#environment = environment;
		this.#fence = fence;
		this.#lifetime = lifetime;
		this.#replace = replace;
		registerWakeFloor(this.ctx, () =>
			this.#releaseAwake === undefined ? undefined : Date.now() + workingWakeMs,
		);
	}

	/**
	 * Stops this engine. Its waits end like a pause, its storage view fails every later call, and
	 * a run it leaves behind ends at its next step without writing.
	 */
	retire(reason: Error): void {
		this.#fence.aborted ??= reason;
		this.#releaseAwake?.();
		this.#releaseAwake = undefined;
		this.timeoutHandler.dispose();
		this.engineAbortController.abort(reason);
		this.pauseController.abort(ABORT_REASONS.USER_PAUSE);
	}

	/**
	 * Workerd's `ctx.abort()` drops the object, and the next call reaches a fresh one built from
	 * storage. Orange's abort restarts the whole actor, and calls that arrive meanwhile fail. The
	 * engine aborts on every terminate, restart, and delete, and the binding calls it again right
	 * after, so the engine is replaced inside the running object instead.
	 * https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/engine.ts#L1223-L1231
	 */
	override async abort(reason: string): Promise<never> {
		await this.ctx.storage.sync();
		const error = new Error(reason);
		this.retire(error);
		this.#replace();
		throw error;
	}

	override workflowTarget(): WorkflowEntrypoint {
		const activity: RunActivity = {
			enter: (kind) => {
				if (kind === "parked") this.#parked++;
				else this.#working++;
				this.#updateAwake();
				let left = false;
				return () => {
					if (left) return;
					left = true;
					if (kind === "parked") this.#parked--;
					else this.#working--;
					this.#updateAwake();
				};
			},
		};
		return {
			run: (event, step) => {
				if (!isEngineStep(step)) throw new TypeError("The engine passed an invalid step");
				return runWorkflowClass(this.#environment, event, workflowStep(step, activity));
			},
		};
	}

	// A run keeps the actor awake, except while every step call in flight is a sleep or an event
	// wait. Those waits are timers in `priority_queue`, so the wake alarm restarts the run after
	// the actor sleeps. Without this, an idle actor could sleep in the middle of a step.
	#updateAwake(): void {
		const hold = this.#runs > 0 && !(this.#parked > 0 && this.#working === 0);
		if (hold && this.#releaseAwake === undefined && this.#fence.aborted === undefined) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#lifetime.keepAwake(promise);
			this.#releaseAwake = resolve;
			void this.priorityQueue?.handleNextAlarm();
		} else if (!hold && this.#releaseAwake !== undefined) {
			this.#releaseAwake();
			this.#releaseAwake = undefined;
			void this.priorityQueue?.handleNextAlarm();
		}
		if (this.#runs > 0 && this.#fence.aborted === undefined) {
			this.#reportWaiting(!hold);
		}
	}

	// Cloudflare reports `waiting` while an instance hibernates in a sleep or an event wait. Its
	// open engine never sets that status, so the Orange engine sets it while the run only waits.
	// The change queues behind the engine's own status writes, and its read and write are
	// synchronous, so it never replaces a status such as `paused` or `complete`.
	#reportWaiting(waiting: boolean): void {
		const from = waiting ? InstanceStatus.Running : InstanceStatus.Waiting;
		const to = waiting ? InstanceStatus.Waiting : InstanceStatus.Running;
		this.ctx.storage
			.transaction(async () => {
				const kv = this.ctx.storage.kv;
				if (kv.get(engineStatusKey) !== from) return;
				kv.put(engineStatusKey, to);
				this.writeLog(
					waiting ? InstanceEvent.WORKFLOW_WAITING : InstanceEvent.WORKFLOW_RUNNING,
					null,
					null,
					{},
				);
			})
			// Fails only when this engine was aborted or stopped, and then the status is not its own.
			.catch(() => undefined);
	}

	// The alarm that `create()` and the time queue set. It restarts the run after the actor slept.
	// A paused instance keeps its timers, and `resume()` moves them by the time it was paused.
	async wake(): Promise<void> {
		const metadata = await this.ctx.storage.get<InstanceMetadata>(INSTANCE_METADATA);
		if (metadata === undefined) return;
		// The run still works in this generation, so only the working alarm needs to move on.
		if (this.isRunning) {
			void this.priorityQueue?.handleNextAlarm();
			return;
		}
		const status = await this.getStatus();
		if (
			status === InstanceStatus.Complete ||
			status === InstanceStatus.Errored ||
			status === InstanceStatus.Paused ||
			status === InstanceStatus.Terminated
		) {
			return;
		}
		this.#startRun(metadata);
	}

	override async init(
		accountId: number,
		workflow: DatabaseWorkflow,
		version: DatabaseVersion,
		instance: DatabaseInstance,
		event: WorkflowEvent<unknown>,
	): Promise<{ id: string } | undefined> {
		this.#runs++;
		this.#updateAwake();
		try {
			return await super.init(accountId, workflow, version, instance, event);
		} catch (error: unknown) {
			// The engine starts runs without awaiting them. A run of an aborted or stopped engine
			// fails at its next storage call, which is expected.
			if (!isAbortError(error) && this.#fence.aborted === undefined) reportError(error);
			return undefined;
		} finally {
			this.#runs--;
			this.#updateAwake();
		}
	}

	/**
	 * Creates the instance. Workerd's binding calls `init()` and holds it in `waitUntil()`, so the
	 * caller's request would live as long as the run. Here the instance is stored first, so a
	 * duplicate ID fails without a race, and the run starts on its own.
	 */
	async create(
		instanceId: string,
		workflowName: string,
		params: Uint8Array,
		createdAt: number,
	): Promise<void> {
		if (await this.hasInstance()) throw duplicateInstanceError(instanceId);
		const now = new Date(createdAt).toISOString();
		const metadata: InstanceMetadata = {
			accountId: 0,
			event: {
				instanceId,
				payload: deserialize(params),
				timestamp: new Date(createdAt),
				workflowName,
			},
			instance: {
				created_on: now,
				ended_on: null,
				id: instanceId,
				modified_on: now,
				started_on: now,
				status: 0,
				version_id: "",
				workflow_id: "",
			},
			// SAFETY: Cloudflare's local binding passes these empty too. The engine reads only
			// `version.id`, for a log field.
			version: {} as DatabaseVersion,
			// SAFETY: As above. The engine stores the workflow record without reading it.
			workflow: {} as DatabaseWorkflow,
		};
		await this.ctx.storage.put(INSTANCE_METADATA, metadata);
		// The same log rows that `init()` writes for a new instance.
		// https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/engine.ts#L1714-L1733
		this.writeLog(InstanceEvent.WORKFLOW_QUEUED, null, null, {
			params: metadata.event.payload,
			trigger: { source: InstanceTrigger.API },
			versionId: metadata.version.id,
		});
		this.writeLog(InstanceEvent.WORKFLOW_START, null, null, {});
		// The run starts from the alarm, outside the caller's request. If the process stops first,
		// the alarm still starts it.
		await this.ctx.storage.setAlarm(Date.now());
	}

	#startRun(metadata: InstanceMetadata): void {
		void this.init(
			metadata.accountId,
			metadata.workflow,
			metadata.version,
			metadata.instance,
			metadata.event,
		);
	}

	// `status()` of workerd's WorkflowHandle, computed here so the logs stay in the object.
	// https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/binding.ts#L861-L916
	async readStatus(): Promise<WorkflowInstanceStatusResult> {
		const status = await this.getStatus();
		const success = this.readLogsFromEvent(InstanceEvent.WORKFLOW_SUCCESS).logs[0];
		const failure = this.readLogsFromEvent(InstanceEvent.WORKFLOW_FAILURE).logs[0];
		const error: unknown = failure?.metadata.error;
		return {
			...(isErrorInfo(error) ? { error: { message: error.message, name: error.name } } : {}),
			output: success?.metadata.result ?? null,
			status: instanceStatusName(status),
		};
	}

	// Payloads cross Orange's RPC as V8 serialization, so they keep structured-clone types.
	async sendEvent(type: string, payload: Uint8Array): Promise<void> {
		const event = { payload: deserialize(payload), timestamp: new Date(), type };
		// The engine queues the event in memory and then stores it inside blockConcurrencyWhile(),
		// where a storage error resets the object and errors the run. So an event over the storage
		// value limit fails here first, and the instance stays as it was.
		// https://github.com/cloudflare/workers-sdk/blob/4a5377fc228dd94aa5df7545c8185cdd98be733e/packages/workflows-shared/src/engine.ts#L1242-L1288
		serializeStoredValue(`EVENT_MAP\n${type}\n${this.eventMap.get(type)?.length ?? 0}`, event);
		await this.receiveEvent(event);
	}
}

/**
 * The Durable Object of one Workflow instance. It holds the current engine and forwards the RPC
 * methods that Orange's Workflow binding calls.
 */
export class WorkflowEngineObject extends DurableObject {
	#engine: OrangeEngine;

	constructor(state: DurableObjectState, environment: Record<string, unknown>) {
		super(state, environment);
		const lifetime = internalObjectLifetime(state);
		const build = (): OrangeEngine =>
			new OrangeEngine(state, environment, lifetime, () => {
				this.#engine = build();
			});
		this.#engine = build();
		// A run of a stopped object can still hold timers. They end, and its next storage call
		// fails, so it never writes over the next generation.
		lifetime.retired.addEventListener(
			"abort",
			() => {
				this.#engine.retire(new Error("The Workflow engine object stopped"));
			},
			{ once: true },
		);
	}

	// The alarm that `create()` and the time queue set. It restarts the run after the actor slept.
	override alarm = (): Promise<void> => this.#engine.wake();

	create(instanceId: string, workflowName: string, params: Uint8Array, createdAt: number): Promise<void> {
		return this.#engine.create(instanceId, workflowName, params, createdAt);
	}

	readStatus(): Promise<WorkflowInstanceStatusResult> {
		return this.#engine.readStatus();
	}

	sendEvent(type: string, payload: Uint8Array): Promise<void> {
		return this.#engine.sendEvent(type, payload);
	}

	changeInstanceStatus(
		newStatus: "resume" | "pause" | "terminate" | "restart",
		from?: RestartFromStep,
		terminateOptions?: WorkflowInstanceTerminateOptions,
	): Promise<void> {
		return this.#engine.changeInstanceStatus(newStatus, from, terminateOptions);
	}

	attemptRestart(): Promise<void> {
		return this.#engine.attemptRestart();
	}

	deleteInstance(): Promise<void> {
		return this.#engine.deleteInstance();
	}

	hasInstance(): Promise<boolean> {
		return this.#engine.hasInstance();
	}
}

function isErrorInfo(value: unknown): value is { message: string; name: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "message") === "string" &&
		typeof Reflect.get(value, "name") === "string"
	);
}
