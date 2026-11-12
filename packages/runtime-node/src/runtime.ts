import { createEnvironment, type EnvironmentBinding } from "./bindings/create-env.js";
import {
	discoverDurableObjectClasses,
	type ConfiguredDurableObjectClass,
	type DurableObjectManifest,
} from "./bindings/durable-objects/classes.js";
import {
	createContextExports,
	LoopbackServices,
} from "./bindings/service.js";
import { defaultEmailHandler, dispatchEmailRequest } from "./events/email.js";
import type { Response as WorkerResponse } from "./globals/http.js";
import { dispatchFetch, type FetchDispatch, type FetchHandler } from "./events/fetch.js";
import {
	defaultScheduledHandler,
	dispatchScheduled,
	type ScheduledHandler,
	type ScheduledResult,
} from "./events/scheduled.js";
import { defaultQueueHandler, dispatchQueue, type QueueDispatch } from "./events/queue.js";
import type { MessageBatchMetadata } from "./bindings/queues/batch.js";
import type { QueueEnvelope } from "./bindings/queues/envelope.js";
import { Request } from "./globals/http.js";
import { installCloudflareGlobalsBeforeImport } from "./globals/install.js";
import {
	setImportableWorkerEnv,
	setImportableWorkerExports,
} from "./modules/cloudflare-workers/env.js";
import { isWorkerEntrypointClass } from "./modules/cloudflare-workers/worker-entrypoint.js";
import { isRecord } from "./bindings/unknown-values.js";
import { setWorkerProcessEnv } from "./modules/node/process-env.js";

// Matches RivetKit. `globals/node-polyfills.ts` fills what Node.js 22 lacks.
export const MINIMUM_NODE_MAJOR_VERSION: 22 = 22;

export function assertSupportedNodeVersion(version = process.versions.node): void {
	const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
	if (!(major >= MINIMUM_NODE_MAJOR_VERSION)) {
		throw new Error(
			`OpenOrange requires Node.js ${MINIMUM_NODE_MAJOR_VERSION} or later; received ${version}`,
		);
	}
}

function isFetchHandler(value: unknown): value is FetchHandler {
	return typeof value === "function";
}

export interface ServiceBindingOptions {
	binding: string;
	entrypoint?: string;
	props?: unknown;
}

export interface WorkerEntrypointOptions {
	bindings?: Iterable<EnvironmentBinding>;
	durableObjectManifest?: DurableObjectManifest;
	// Durable Object namespaces by class name, exposed through `ctx.exports`.
	durableObjectNamespaces?: ReadonlyMap<string, unknown>;
	globalTarget?: object;
	importWorker(): Promise<unknown>;
	// Service bindings that call back into this Worker's own entrypoints.
	serviceBindings?: Iterable<ServiceBindingOptions>;
}

// A class default export extends WorkerEntrypoint and handles each request
// with a new instance.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/workers-module.h#L27-L33
function defaultFetchHandler(defaultExport: unknown): FetchHandler | undefined {
	if (isWorkerEntrypointClass(defaultExport)) {
		if (typeof Reflect.get(defaultExport.prototype, "fetch") !== "function") {
			return undefined;
		}
		return (request, environment, context) => {
			const instance = Reflect.construct(defaultExport, [context, environment]);
			return Reflect.apply(Reflect.get(instance, "fetch"), instance, [request]);
		};
	}
	// A module without a default export serves only its named entrypoints, as in workerd.
	if (defaultExport === undefined) return undefined;
	if (!isRecord(defaultExport)) {
		throw new TypeError("Worker entrypoint must have a default object export");
	}
	// Other event handlers have their own dispatch, such as dispatchScheduled()
	// and defaultQueueHandler().
	const handler = defaultExport.fetch;
	return isFetchHandler(handler) ? handler : undefined;
}


export interface ScheduledEvent {
	cron: string;
	scheduledTime: number;
}

export interface LoadedWorkerEntrypoint {
	// `ctx.exports` for events that the runtime dispatches into this Worker.
	contextExports: object;
	environment: Record<string, unknown>;
	durableObjectClasses: ReadonlyMap<string, ConfiguredDurableObjectClass>;
	exports: Record<string, unknown>;
	// Runs the Worker's entrypoints for calls from other Workers of the session.
	services: LoopbackServices;
	dispatch<Props = unknown>(request: Request, props: Props): Promise<FetchDispatch<Props>>;
	// Wrangler's local email route. Only `orange dev` serves it.
	dispatchEmail(request: Request): Promise<WorkerResponse>;
	dispatchScheduled(event: ScheduledEvent): Promise<ScheduledResult>;
	// Delivers one batch to the Worker's queue() handler.
	queue(
		queueName: string,
		envelopes: readonly QueueEnvelope[],
		metadata: MessageBatchMetadata,
	): Promise<QueueDispatch>;
	// A service stub to one of this Worker's entrypoints, like a self service
	// binding with `props`.
	entrypoint(name: string | undefined, props: unknown): object;
}

export async function loadWorkerEntrypoint(
	options: WorkerEntrypointOptions,
): Promise<LoadedWorkerEntrypoint> {
	// The agentOS VM runs Node.js 22, and its bundle shims the gaps.
	if (Reflect.get(globalThis, Symbol.for("open-orange.agentos-vm")) !== true) {
		assertSupportedNodeVersion();
	}
	const services = new LoopbackServices();
	const serviceBindings: EnvironmentBinding[] = [];
	for (const service of options.serviceBindings ?? []) {
		serviceBindings.push({
			name: service.binding,
			value: services.binding(service.entrypoint, service.props),
		});
	}
	const environment = createEnvironment([
		...(options.bindings ?? []),
		...serviceBindings,
	]);
	// The importable env and process.env are readable while the Worker module evaluates.
	setImportableWorkerEnv(environment);
	setWorkerProcessEnv(environment);
	const workerModule = await installCloudflareGlobalsBeforeImport(
		options.importWorker,
		options.globalTarget,
	);
	if (!isRecord(workerModule)) {
		throw new TypeError("Worker entrypoint module must export a module namespace");
	}
	// A Worker without a fetch handler loads, and each request fails, as in workerd.
	const handler: FetchHandler =
		defaultFetchHandler(workerModule.default) ??
		(() => {
			throw new Error("Handler does not export a fetch() function.");
		});
	const scheduledHandler = defaultScheduledHandler(workerModule.default);
	const emailHandler = defaultEmailHandler(workerModule.default);

	const namedExports: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(workerModule)) {
		if (name !== "default") {
			namedExports[name] = value;
		}
	}
	const contextExports = createContextExports(
		services,
		namedExports,
		options.durableObjectNamespaces ?? new Map(),
	);
	// `import { exports } from "cloudflare:workers"` reads the same object as
	// ctx.exports.
	setImportableWorkerExports(contextExports);
	services.attach({
		contextExports,
		environment,
		exports: { ...workerModule },
	});
	const queueHandler = defaultQueueHandler(workerModule.default);
	const durableObjectClasses = discoverDurableObjectClasses(
		namedExports,
		options.durableObjectManifest ?? { classes: [] },
	);
	return {
		contextExports,
		durableObjectClasses,
		environment,
		exports: namedExports,
		services,
		dispatch<Props>(request: Request, props: Props): Promise<FetchDispatch<Props>> {
			return dispatchFetch({
				environment,
				exports: contextExports,
				handler,
				props,
				request,
			});
		},
		dispatchEmail(request: Request): Promise<WorkerResponse> {
			return dispatchEmailRequest(request, {
				environment,
				exports: contextExports,
				handler: emailHandler,
			});
		},
		dispatchScheduled(event: ScheduledEvent): Promise<ScheduledResult> {
			return dispatchScheduled({
				cron: event.cron,
				environment,
				exports: contextExports,
				handler: scheduledHandler,
				props: undefined,
				scheduledTime: event.scheduledTime,
			});
		},
		queue(queueName, envelopes, metadata): Promise<QueueDispatch> {
			return dispatchQueue({
				envelopes,
				environment,
				exports: contextExports,
				handler: queueHandler,
				metadata,
				queueName,
			});
		},
		entrypoint(name: string | undefined, props: unknown): object {
			return services.binding(name, props);
		},
	};
}
