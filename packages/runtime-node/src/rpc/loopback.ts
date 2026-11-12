// In-process JS RPC with workerd semantics. Service bindings and `new RpcStub()`
// stay inside one Orange process, so calls skip the wire but keep workerd's
// observable rules: values are cloned, functions and RpcTargets travel as
// stubs, results pipeline, and stubs are disposable.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-rpc.h#L196-L560

import { abortWriter, closeWriter, readerOf, writeTo, writerOf } from "../internal/stream-methods.js";
import { types } from "node:util";

import {
	currentExecutionContext,
	onExecutionContextRelease,
	runInExecutionContext,
	type ExecutionContext,
} from "../context.js";

import {
	isCapnWebRpcStub,
	isCapnWebRpcTarget,
} from "../bindings/durable-objects/rpc/capnweb.js";
import { isDurableObjectStub } from "../bindings/durable-objects/namespace.js";
import {
	DurableObjectRpcTarget,
	type RpcStubConstructor,
} from "../bindings/durable-objects/rpc/target.js";
import { Headers, Request, Response } from "../globals/http.js";
import { waitForOutputGate } from "../internal/output-gate.js";
import { Socket, transferSocket } from "../modules/cloudflare-sockets/socket.js";
import {
	AbortController,
	AbortSignal,
	Blob,
	ReadableStream,
	WritableStream,
} from "../globals/native.js";

type Path = readonly string[];

const { isProxy } = types;


export interface CallOutcome {
	// The result as the caller sees it, already cloned out of the callee.
	readonly value: Promise<unknown>;
	// Receives calls pipelined on the result before `value` settles.
	readonly pipeline: Promise<Capability>;
}

export interface Capability {
	// `args === undefined` reads the property at `path` instead of calling it.
	call(path: Path, args: readonly unknown[] | undefined): CallOutcome;
	dup(): Capability;
	dispose(): void;
}

// RPC promises, pipelined properties, and stubs belong to the request that
// created them. Using one from another request fails like workerd's I/O
// objects do.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/io-context.c%2B%2B#L1648-L1676
function crossContextError(type: "Client" | "JsRpcPromise" | "Pipeline"): Error {
	return new Error(
		`Cannot perform I/O on behalf of a different request. I/O objects (such as streams, request/response bodies, and others) created in the context of one request handler cannot be accessed from a different request's handler. This is a limitation of Cloudflare Workers which allows us to improve overall performance. (I/O type: ${type})`,
	);
}

function requireOwner(
	owner: ExecutionContext | undefined,
	current: ExecutionContext | undefined,
	type: "Client" | "JsRpcPromise" | "Pipeline",
): void {
	if (owner !== undefined && current !== undefined && owner !== current) {
		throw crossContextError(type);
	}
}

function disposedStubError(): Error {
	return new Error("RPC stub used after being disposed.");
}

function dataCloneError(typeName: string): DOMException {
	return new DOMException(
		`Could not serialize object of type "${typeName}". This type does not support serialization.`,
		"DataCloneError",
	);
}

function failLookup(name: string): never {
	throw new TypeError(`The RPC receiver does not implement the method "${name}".`);
}

function settle<Value>(promise: Promise<Value>): Promise<Value> {
	promise.catch(() => undefined);
	return promise;
}

export function failedOutcome(error: unknown): CallOutcome {
	return {
		pipeline: settle(Promise.reject(error)),
		value: settle(Promise.reject(error)),
	};
}

// Collects the stubs created while a parameter or result set is cloned, so
// they can be released together.
class DisposalGroup {
	readonly #capabilities: Capability[] = [];
	readonly #disposers: (() => void)[] = [];
	#disposed = false;

	add(capability: Capability): void {
		if (this.#disposed) capability.dispose();
		else this.#capabilities.push(capability);
	}

	onDispose(disposer: () => void): void {
		if (this.#disposed) disposer();
		else this.#disposers.push(disposer);
	}

	get empty(): boolean {
		return this.#capabilities.length === 0 && this.#disposers.length === 0;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const capability of this.#capabilities.splice(0)) capability.dispose();
		for (const disposer of this.#disposers.splice(0)) {
			try {
				disposer();
			} catch {
				// Disposers are best effort, like workerd's server-side dispose() call.
			}
		}
	}
}

export interface LookupRules {
	// Plain objects and functions expose their own properties. RpcTargets
	// expose only class members.
	readonly allowInstanceProperties: boolean;
	readonly reserved: ReadonlySet<string>;
}

const stubReservedNames: ReadonlySet<string> = new Set(["constructor", "dup"]);

const objectPrototype = Object.prototype;

function isRpcTarget(value: object): boolean {
	return value instanceof DurableObjectRpcTarget || isCapnWebRpcTarget(value);
}

// Foreign stubs come from other RPC systems in Orange, such as Durable Object
// stubs and Cap'n Web stubs. They already forward calls, so the loopback
// passes them by reference.
interface ForeignStubKind {
	// Returns the receiver's copy. A service stub gets a new identity, as a
	// Fetcher deserialized from RPC does.
	clone?(value: object): object;
	is(value: object): boolean;
}

const foreignStubKinds: ForeignStubKind[] = [
	{ is: isCapnWebRpcStub },
	{ is: isDurableObjectStub },
];

export function registerForeignStub(kind: ForeignStubKind): void {
	foreignStubKinds.push(kind);
}

function foreignStubKind(value: object): ForeignStubKind | undefined {
	return foreignStubKinds.find((kind) => kind.is(value));
}

function isForeignStub(value: object): boolean {
	return foreignStubKind(value) !== undefined;
}

function isPlainObject(value: object): boolean {
	return Object.getPrototypeOf(value) === objectPrototype;
}

// Mirrors workerd's tryGetProperty(): reserved names fail, RpcTargets expose
// class members but not own or Object.prototype properties, and plain objects
// expose own properties only.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-rpc.c%2B%2B#L1550-L1680
function lookupPath(
	root: object,
	path: Path,
	rules: LookupRules,
): { holder: object; value: unknown } {
	let object = root;
	let allowInstanceProperties = rules.allowInstanceProperties;
	let descendedIntoStub = false;
	const getProperty = (name: string): unknown => {
		if (rules.reserved.has(name)) {
			throw new TypeError(`'${name}' is a reserved method and cannot be called over RPC.`);
		}
		if (descendedIntoStub) return Reflect.get(object, name);
		if (allowInstanceProperties) {
			if (!Object.hasOwn(object, name)) failLookup(name);
			return Reflect.get(object, name);
		}
		if (Object.hasOwn(object, name)) failLookup(name);
		const value: unknown = Reflect.get(object, name);
		if (value === Reflect.get(objectPrototype, name)) failLookup(name);
		return value;
	};
	if (path.length === 0) return { holder: object, value: object };
	for (const name of path.slice(0, -1)) {
		const next = getProperty(name);
		if ((typeof next !== "object" || next === null) && typeof next !== "function") {
			failLookup(name);
		}
		object = next;
		const kind = clientKind(object);
		if (kind === "stub" || isForeignStub(object) || (descendedIntoStub && kind === "property")) {
			descendedIntoStub = true;
		} else if (kind !== undefined) {
			failLookup(name);
		} else if (typeof object === "object" && isPlainObject(object)) {
			allowInstanceProperties = true;
		} else if (isRpcTarget(object)) {
			allowInstanceProperties = false;
		} else if (typeof object === "function") {
			allowInstanceProperties = true;
		} else {
			failLookup(name);
		}
	}
	const last = path.at(-1);
	if (last === undefined) throw new Error("RPC path is empty");
	return { holder: object, value: getProperty(last) };
}

// Shared by every duplicate of one stub so the target's disposer runs once,
// after the last duplicate is released.
class TargetReference {
	references = 1;

	constructor(readonly target: object) {}

	release(): void {
		this.references -= 1;
		if (this.references !== 0) return;
		const dispose: unknown = Reflect.get(this.target, Symbol.dispose);
		if (typeof dispose === "function") {
			try {
				Reflect.apply(dispose, this.target, []);
			} catch (error: unknown) {
				void Promise.reject(error);
			}
		}
	}
}

interface InvocationHooks {
	// The execution context the callee runs in, if it has one.
	readonly context?: ExecutionContext;
	// Runs the callee. Entrypoints use it to install their execution context.
	run<Result>(callback: () => Result): Result;
	// Ends the callee's event once the caller no longer needs it: when the call
	// fails, when its result holds no stubs and no disposer, or else when the
	// caller disposes the result.
	end?(): void;
}

const directInvocation: InvocationHooks = {
	run: (callback) => callback(),
};

// workerd delivers a call to an RpcTarget or function in the context that
// exported it, not in the caller's.
function invocationIn(context: ExecutionContext | undefined): InvocationHooks {
	if (context === undefined) return directInvocation;
	return { context, run: (callback) => runInExecutionContext(context, callback) };
}

// Calls `path` on a local value with workerd's lookup rules, clones the
// arguments into the callee, and clones the result back out.
export function callLocal(
	root: object,
	path: Path,
	args: readonly unknown[] | undefined,
	rules: LookupRules,
	hooks: InvocationHooks = directInvocation,
	invoke?: (member: Function, holder: object, args: unknown[]) => unknown,
): CallOutcome {
	const parameters = new DisposalGroup();
	const callerContext = currentExecutionContext();
	let received: unknown[] | undefined;
	try {
		received =
			args === undefined
				? undefined
				: transferArguments(args, parameters, callerContext, hooks.context);
	} catch (error: unknown) {
		parameters.dispose();
		hooks.end?.();
		return failedOutcome(error);
	}
	// A Durable Object's call leaves after its earlier writes are durable. The
	// arguments are already cloned, so later changes by the caller do not show.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-rpc.c%2B%2B#L558-L562
	const outputLock = waitForOutputGate();
	const value = settle(
		(async (): Promise<unknown> => {
			// workerd delivers calls through the event loop, so the callee never
			// runs inside the caller's synchronous turn.
			try {
				await (outputLock ?? null);
			} catch (error: unknown) {
				parameters.dispose();
				hooks.end?.();
				throw error;
			}
			let result: unknown;
			try {
				result = await hooks.run(async () => {
					const { holder, value: member } = lookupPath(root, path, rules);
					if (received === undefined) return member;
					if (typeof member !== "function") {
						throw new TypeError(`"${path.join(".")}" is not a function.`);
					}
					return invoke === undefined
						? Reflect.apply(member, holder, received)
						: invoke(member, holder, received);
				});
			} catch (error: unknown) {
				parameters.dispose();
				hooks.end?.();
				throw transferError(error);
			}
			// The result is cloned before the parameter stubs are released, so a
			// callee may return a stub it received.
			try {
				return await transferResult(
					result,
					hooks.context ?? callerContext,
					callerContext,
					hooks.end,
				);
			} catch (error: unknown) {
				hooks.end?.();
				throw error;
			} finally {
				parameters.dispose();
			}
		})(),
	);
	// Pipelined calls go to the caller's copy of the result. The copy holds the
	// transferred stubs, so it reaches the same targets as the callee's value.
	return {
		pipeline: settle(value.then((result) => pipelineCapability(result, callerContext))),
		value,
	};
}

// The capability that receives calls pipelined on a call's result.
export function pipelineCapability(
	result: unknown,
	context: ExecutionContext | undefined,
): Capability {
	if (typeof result === "function" && isLoopbackStub(result)) {
		return requireClient(result).capability().dup();
	}
	if ((typeof result === "object" && result !== null) || typeof result === "function") {
		if (isForeignStub(result)) return new ForeignCapability(result);
		const allowInstanceProperties =
			typeof result === "function" || isPlainObject(result);
		return new LocalCapability(
			new TargetReference(result),
			{ allowInstanceProperties, reserved: stubReservedNames },
			context,
		);
	}
	return new NonObjectCapability();
}

// A primitive result has no members, so every pipelined name fails lookup.
class NonObjectCapability implements Capability {
	call(path: Path): CallOutcome {
		try {
			failLookup(path[0] ?? "(this)");
		} catch (error: unknown) {
			return failedOutcome(error);
		}
	}

	dup(): Capability {
		return this;
	}

	dispose(): void {}
}

class LocalCapability implements Capability {
	readonly #context: ExecutionContext | undefined;
	readonly #reference: TargetReference;
	readonly #rules: LookupRules;
	#released = false;

	constructor(
		reference: TargetReference,
		rules: LookupRules,
		context: ExecutionContext | undefined,
	) {
		this.#context = context;
		this.#reference = reference;
		this.#rules = rules;
	}

	static for(
		target: object,
		rules: LookupRules,
		context: ExecutionContext | undefined,
	): LocalCapability {
		return new LocalCapability(new TargetReference(target), rules, context);
	}

	call(path: Path, args: readonly unknown[] | undefined): CallOutcome {
		if (this.#released) return failedOutcome(disposedStubError());
		return callLocal(
			this.#reference.target,
			path,
			args,
			this.#rules,
			invocationIn(this.#context),
		);
	}

	dup(): Capability {
		if (this.#released) return new ErrorCapability(disposedStubError());
		this.#reference.references += 1;
		return new LocalCapability(this.#reference, this.#rules, this.#context);
	}

	dispose(): void {
		if (this.#released) return;
		this.#released = true;
		this.#reference.release();
	}
}

class ErrorCapability implements Capability {
	constructor(readonly error: unknown) {}

	call(): CallOutcome {
		return failedOutcome(this.error);
	}

	dup(): Capability {
		return this;
	}

	dispose(): void {}
}

// Forwards to a capability that is not known yet, such as the result of a
// call that is still running.
class PromiseCapability implements Capability {
	readonly #capability: Promise<Capability>;
	#released = false;

	constructor(capability: Promise<Capability>) {
		this.#capability = settle(capability);
	}

	call(path: Path, args: readonly unknown[] | undefined): CallOutcome {
		if (this.#released) return failedOutcome(disposedStubError());
		const outcome = this.#capability.then((capability) => capability.call(path, args));
		return {
			pipeline: settle(outcome.then((result) => result.pipeline)),
			value: settle(outcome.then((result) => result.value)),
		};
	}

	dup(): Capability {
		return new PromiseCapability(this.#capability.then((capability) => capability.dup()));
	}

	dispose(): void {
		if (this.#released) return;
		this.#released = true;
		void this.#capability.then(
			(capability) => capability.dispose(),
			() => undefined,
		);
	}
}

// Calls through a stub from another Orange RPC system with plain property
// access, since that system clones its own arguments.
class ForeignCapability implements Capability {
	readonly #stub: object;

	constructor(stub: object) {
		this.#stub = stub;
	}

	call(path: Path, args: readonly unknown[] | undefined): CallOutcome {
		const context = currentExecutionContext();
		const value = settle(
			(async (): Promise<unknown> => {
				let holder: unknown = this.#stub;
				let member: unknown = this.#stub;
				for (const name of path) {
					holder = member;
					member = Reflect.get(Object(member), name);
				}
				if (args === undefined) return await member;
				if (typeof member !== "function") {
					throw new TypeError(`"${path.join(".")}" is not a function.`);
				}
				return await Reflect.apply(member, holder, [...args]);
			})(),
		);
		return {
			pipeline: settle(value.then((result) => pipelineCapability(result, context))),
			value,
		};
	}

	dup(): Capability {
		const dup: unknown = Reflect.get(this.#stub, "dup");
		return typeof dup === "function"
			? new ForeignCapability(Reflect.apply(dup, this.#stub, []))
			: this;
	}

	dispose(): void {
		const dispose: unknown = Reflect.get(this.#stub, Symbol.dispose);
		if (typeof dispose === "function") Reflect.apply(dispose, this.#stub, []);
	}
}

// ---------------------------------------------------------------------------
// Client-side objects: RpcStub, RpcProperty, and RpcPromise.

interface Client {
	readonly kind: "promise" | "property" | "stub";
	// The capability that receives calls, and the path inside it.
	capability(): Capability;
	// The execution context the client belongs to. Clients made outside a
	// request, such as a service binding, belong to none.
	readonly owner: ExecutionContext | undefined;
	// True for an RpcPromise and the properties pipelined on one.
	readonly pipelined: boolean;
	readonly path: Path;
}

const clients = new WeakMap<object, Client>();

function requireClient(value: object): Client {
	const client = clients.get(value);
	if (client === undefined) throw new TypeError("Illegal invocation");
	return client;
}

function isLoopbackClient(value: unknown): boolean {
	return (typeof value === "object" || typeof value === "function") &&
		value !== null &&
		clients.has(value);
}

export function isLoopbackStub(value: unknown): boolean {
	return isLoopbackClient(value) && requireClient(Object(value)).kind === "stub";
}

function clientKind(value: object): Client["kind"] | undefined {
	return clients.get(value)?.kind;
}

function propertyOf(parent: Client, name: string): object {
	// Workerd stops a property path at 64 to protect its native stack. Orange keeps the path in an
	// array, so it has no such limit.
	return createProperty({
		capability: () => parent.capability(),
		kind: "property",
		owner: parent.owner,
		path: [...parent.path, name],
		pipelined: parent.pipelined,
	});
}

// Errors thrown by a callee. Their stack is replaced by the caller's.
const remoteErrors = new WeakSet<object>();

// workerd gives a remote error the local stack of the code that awaits it,
// including its `at async` frames. Capturing the stack inside an async
// function that the caller awaits lets V8 walk the caller's await chain.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/js-rpc-test.js#L1867-L1884
async function awaitWithLocalStack(promise: Promise<unknown>): Promise<unknown> {
	try {
		return await promise;
	} catch (error: unknown) {
		if (typeof error === "object" && error !== null && remoteErrors.has(error)) {
			Error.captureStackTrace(error);
		}
		throw error;
	}
}

function thenableMethods(readValue: () => Promise<unknown>): Record<string, Function> {
	const read = (): Promise<unknown> => awaitWithLocalStack(readValue());
	return {
		catch(onRejected?: (reason: unknown) => unknown): Promise<unknown> {
			return read().catch(onRejected);
		},
		finally(onFinally?: () => void): Promise<unknown> {
			return read().finally(onFinally);
		},
		then(
			onFulfilled?: (value: unknown) => unknown,
			onRejected?: (reason: unknown) => unknown,
		): Promise<unknown> {
			return read().then(onFulfilled, onRejected);
		},
	};
}

function callClient(client: Client, args: unknown[]): object {
	let outcome: CallOutcome;
	try {
		if (client.pipelined) {
			requireOwner(client.owner, currentExecutionContext(), "JsRpcPromise");
		}
		outcome = client.capability().call(client.path, args);
	} catch (error: unknown) {
		outcome = failedOutcome(error);
	}
	return createPromise(outcome);
}

function createClientProxy(
	client: Client,
	prototype: object,
	members: Record<string | symbol, unknown>,
): object {
	// An arrow function target keeps the client callable without exposing a
	// non-configurable `prototype` property.
	const target = (): void => undefined;
	const proxy = new Proxy(target, {
		apply(_target, _thisArg, args: unknown[]): unknown {
			return callClient(client, args);
		},
		get(_target, property): unknown {
			if (Object.hasOwn(members, property)) return members[property];
			// A stub is not a thenable, so awaiting one yields the stub itself.
			if (property === "then") return undefined;
			if (typeof property === "symbol") {
				return property === Symbol.toStringTag
					? Reflect.get(prototype, Symbol.toStringTag)
					: undefined;
			}
			return propertyOf(client, property);
		},
		getPrototypeOf(): object {
			return prototype;
		},
		has(_target, property): boolean {
			return Object.hasOwn(members, property);
		},
		set(): boolean {
			return false;
		},
	});
	clients.set(proxy, client);
	return proxy;
}

export function createStub(
	capability: Capability,
	owner: ExecutionContext | undefined = undefined,
): object {
	let current: Capability | undefined = capability;
	const client: Client = {
		capability(): Capability {
			if (current === undefined) return new ErrorCapability(disposedStubError());
			return current;
		},
		kind: "stub",
		owner,
		path: [],
		pipelined: false,
	};
	let unregister = (): void => {};
	const dispose = (): void => {
		const released = current;
		current = undefined;
		unregister();
		released?.dispose();
	};
	// A stub belongs to the context that made or received it, and is disposed
	// when that context aborts or its event ends.
	unregister = onExecutionContextRelease(owner, dispose);
	const members: Record<string | symbol, unknown> = {
		dup(): object {
			return createStub(client.capability().dup(), owner);
		},
		[Symbol.dispose]: dispose,
	};
	return createClientProxy(client, RpcStub.prototype, members);
}

// Takes the capability out of a stub, leaving the stub disposed. Used when a
// stub is passed as an RPC parameter, which transfers ownership.
function takeStubCapability(stub: object): Capability {
	const capability = requireClient(stub).capability().dup();
	const dispose: unknown = Reflect.get(stub, Symbol.dispose);
	if (typeof dispose === "function") Reflect.apply(dispose, stub, []);
	return capability;
}

function createProperty(client: Client): object {
	const read = (): Promise<unknown> => {
		try {
			if (client.pipelined) {
				requireOwner(client.owner, currentExecutionContext(), "Pipeline");
			}
			return client.capability().call(client.path, undefined).value;
		} catch (error: unknown) {
			return settle(Promise.reject(error));
		}
	};
	return createClientProxy(client, RpcProperty.prototype, thenableMethods(read));
}

function createPromise(outcome: CallOutcome): object {
	let disposed = false;
	const pipeline = new PromiseCapability(outcome.pipeline);
	const client: Client = {
		capability: () => pipeline,
		kind: "promise",
		owner: currentExecutionContext(),
		path: [],
		pipelined: true,
	};
	// The pipeline holds its own reference to the result, so a caller that only awaits the promise
	// and disposes the result would otherwise keep the result's target alive.
	const stopOwning = onExecutionContextRelease(client.owner, () => pipeline.dispose());
	const members: Record<string | symbol, unknown> = {
		...thenableMethods(() => outcome.value),
		[Symbol.dispose](): void {
			if (disposed) return;
			disposed = true;
			stopOwning();
			pipeline.dispose();
			void outcome.value.then(
				(value) => disposeValue(value),
				() => undefined,
			);
		},
	};
	return createClientProxy(client, RpcPromise.prototype, members);
}

function disposeValue(value: unknown): void {
	if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
	const dispose: unknown = Reflect.get(value, Symbol.dispose);
	if (typeof dispose === "function") Reflect.apply(dispose, value, []);
}

function makeStubFromValue(value: object): object {
	const context = currentExecutionContext();
	if (isLoopbackStub(value)) {
		return createStub(requireClient(value).capability().dup(), context);
	}
	if (isForeignStub(value)) return createStub(new ForeignCapability(value), context);
	const allowInstanceProperties = typeof value === "function" || isPlainObject(value);
	return createStub(
		LocalCapability.for(
			value,
			{ allowInstanceProperties, reserved: stubReservedNames },
			context,
		),
		context,
	);
}

// The classes exist for `instanceof`; instances come from the factories above.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-rpc.h#L428-L520

// SAFETY: The function is only usable with `new` and returns a stub for the wrapped value.
// TypeScript cannot type a function expression as a generic construct signature.
export const RpcStub = function RpcStub(this: unknown, value: unknown): object {
	if (new.target === undefined) {
		throw new TypeError("Class constructor RpcStub cannot be invoked without 'new'");
	}
	if ((typeof value !== "object" || value === null) && typeof value !== "function") {
		throw new TypeError("RpcStub can only wrap an object or function.");
	}
	return makeStubFromValue(value);
} as unknown as RpcStubConstructor;

export class RpcProperty {
	constructor() {
		throw new TypeError("Illegal constructor");
	}
}

export class RpcPromise {
	constructor() {
		throw new TypeError("Illegal constructor");
	}
}

for (const [constructor, name] of [
	[RpcStub, "RpcStub"],
	[RpcProperty, "RpcProperty"],
	[RpcPromise, "RpcPromise"],
] as const) {
	Object.defineProperty(constructor.prototype, Symbol.toStringTag, {
		configurable: true,
		value: name,
	});
}

// ---------------------------------------------------------------------------
// Value cloning. Each call clones its arguments into the callee and its result
// back out, following workerd's serializer.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-rpc.c%2B%2B#L2040-L2240

interface CloneState {
	readonly group: DisposalGroup;
	// The context that sends the value, which must own the stubs in it, and
	// the context that receives it, which owns the stubs made for it.
	readonly source: ExecutionContext | undefined;
	readonly destination: ExecutionContext | undefined;
	readonly seen: Map<object, unknown>;
	// Parameters duplicate the caller's stubs and dup()-able targets, while
	// results transfer the callee's stubs. Orange's compatibility date
	// enables rpc_params_dup_stubs.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/compatibility-date.capnp#L1306-L1328
	readonly duplicateStubs: boolean;
}

function transferArguments(
	args: readonly unknown[],
	group: DisposalGroup,
	source: ExecutionContext | undefined,
	destination: ExecutionContext | undefined,
): unknown[] {
	const state: CloneState = {
		destination,
		duplicateStubs: true,
		group,
		seen: new Map(),
		source,
	};
	return args.map((arg) => cloneValue(arg, state));
}

async function transferResult(
	result: unknown,
	source: ExecutionContext | undefined,
	destination: ExecutionContext | undefined,
	end?: () => void,
): Promise<unknown> {
	const group = new DisposalGroup();
	const state: CloneState = {
		destination,
		duplicateStubs: false,
		group,
		seen: new Map(),
		source,
	};
	const cloned = cloneValue(result, state);
	const serverDisposer: unknown =
		typeof result === "object" && result !== null && !isLoopbackClient(result)
			? Reflect.get(result, Symbol.dispose)
			: undefined;
	if (typeof serverDisposer === "function") {
		group.onDispose(() => Reflect.apply(serverDisposer, result, []));
	}
	if (end !== undefined) {
		if (group.empty) end();
		else group.onDispose(end);
	}
	if (
		typeof cloned === "object" &&
		cloned !== null &&
		!isLoopbackClient(cloned) &&
		!Object.hasOwn(cloned, Symbol.dispose)
	) {
		Object.defineProperty(cloned, Symbol.dispose, {
			configurable: true,
			enumerable: false,
			value: () => group.dispose(),
			writable: true,
		});
	}
	return cloned;
}

const errorConstructors: Record<string, ErrorConstructor> = {
	Error,
	EvalError,
	RangeError,
	ReferenceError,
	SyntaxError,
	TypeError,
	URIError,
};

// Errors keep their type, message, and own enumerable properties. An error
// thrown by a callee gains `remote: true` and a local stack, because workerd
// does not trust the remote stack when it deserializes the error.
function cloneError(error: Error, state: CloneState, remote: boolean): Error {
	let copy: Error;
	if (error instanceof DOMException) {
		copy = new DOMException(error.message, error.name);
	} else if (error instanceof AggregateError) {
		copy = new AggregateError([], error.message);
	} else {
		const Constructor = errorConstructors[error.name] ?? Error;
		copy = new Constructor(error.message);
		if (copy.name !== error.name) {
			Object.defineProperty(copy, "name", {
				configurable: true,
				enumerable: false,
				value: error.name,
				writable: true,
			});
		}
	}
	state.seen.set(error, copy);
	if (!remote && error.stack !== undefined) {
		Object.defineProperty(copy, "stack", {
			configurable: true,
			enumerable: false,
			value: error.stack,
			writable: true,
		});
	}
	if (error.cause !== undefined) copy.cause = cloneValue(error.cause, state);
	for (const key of Object.keys(error)) {
		if (key === "cause") continue;
		Reflect.set(copy, key, cloneValue(Reflect.get(error, key), state));
	}
	if (remote) {
		Reflect.set(copy, "remote", true);
		remoteErrors.add(copy);
	}
	return copy;
}

/** Copies an error that a callee threw for its caller, with `remote: true`, as workerd does. */
export function transferError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	try {
		return cloneError(
			error,
			{
				destination: undefined,
				duplicateStubs: true,
				group: new DisposalGroup(),
				seen: new Map(),
				source: undefined,
			},
			true,
		);
	} catch {
		return error;
	}
}

function constructorName(value: object): string {
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype === null) return "Object";
	const constructor: unknown = Reflect.get(Object(prototype), "constructor");
	return typeof constructor === "function" && constructor.name !== ""
		? constructor.name
		: "Object";
}

function cloneView(value: ArrayBufferView, state: CloneState): ArrayBufferView {
	const buffer = cloneValue(value.buffer, state);
	if (!(buffer instanceof ArrayBuffer) && !(buffer instanceof SharedArrayBuffer)) {
		throw dataCloneError(constructorName(value));
	}
	if (value instanceof DataView) {
		return new DataView(buffer, value.byteOffset, value.byteLength);
	}
	// SAFETY: A non-DataView ArrayBufferView is a typed array, whose constructor takes
	// (buffer, byteOffset, length). TypeScript types `constructor` as Function.
	const Constructor = value.constructor as new (
		buffer: ArrayBufferLike,
		byteOffset: number,
		length: number,
	) => ArrayBufferView;
	const elementSize = Reflect.get(value, "BYTES_PER_ELEMENT");
	return new Constructor(
		buffer,
		value.byteOffset,
		value.byteLength / (typeof elementSize === "number" ? elementSize : 1),
	);
}

// A stream passed over RPC moves to the receiver. Like workerd, a failure on
// the far side surfaces as a generic disconnect error, not the original reason.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/js-rpc-test.js#L1590-L1745
function transferReadable(stream: ReadableStream): ReadableStream {
	if (stream.locked) throw new TypeError("The ReadableStream has been locked to a reader.");
	const reader = readerOf(stream);
	return new ReadableStream({
		async pull(controller: ReadableStreamDefaultController) {
			let result: { done: boolean; value?: unknown };
			try {
				result = await reader.read();
			} catch {
				throw new Error("ReadableStream received over RPC disconnected prematurely.");
			}
			if (result.done) controller.close();
			else controller.enqueue(result.value);
		},
		cancel(reason: unknown) {
			return reader.cancel(reason);
		},
	});
}

function transferWritable(stream: WritableStream): WritableStream {
	if (stream.locked) throw new TypeError("The WritableStream has been locked to a writer.");
	const writer = writerOf(stream);
	return new WritableStream({
		write(chunk: unknown) {
			return writeTo(writer, chunk);
		},
		close() {
			return closeWriter(writer);
		},
		abort() {
			return abortWriter(
				writer,
				new Error(
					"WritableStream received over RPC was disconnected because the remote execution context has ended.",
				),
			);
		},
	});
}

// workerd mirrors an AbortSignal across RPC: the receiver's copy aborts when
// the sender's signal aborts.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/basics.c%2B%2B#L1108-L1140
function transferSignal(signal: AbortSignal, state: CloneState): AbortSignal {
	const controller = new AbortController();
	const forward = (): void => {
		controller.abort(cloneValue(signal.reason, { ...state, seen: new Map() }));
	};
	if (signal.aborted) forward();
	else signal.addEventListener("abort", forward, { once: true });
	return controller.signal;
}

// A Proxy travels as a stub when its prototype chain says it is an RpcTarget,
// a plain object, or when it is callable.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-rpc.c%2B%2B#L2188-L2238
function proxyStub(proxy: object, state: CloneState): object {
	let allowInstanceProperties: boolean;
	if (isRpcTarget(proxy)) {
		allowInstanceProperties = false;
	} else if (typeof proxy === "function" || isPlainObject(proxy)) {
		allowInstanceProperties = true;
	} else {
		throw new DOMException(
			"Proxy could not be serialized because it is not a valid RPC receiver type. The Proxy must emulate either a plain object or an RpcTarget, as indicated by the Proxy's prototype chain.",
			"DataCloneError",
		);
	}
	const dup: unknown = state.duplicateStubs ? Reflect.get(proxy, "dup") : undefined;
	const target: unknown = typeof dup === "function" ? Reflect.apply(dup, proxy, []) : proxy;
	if ((typeof target !== "object" || target === null) && typeof target !== "function") {
		throw new TypeError("dup() must return an object or function.");
	}
	const capability = LocalCapability.for(
		target,
		{ allowInstanceProperties, reserved: stubReservedNames },
		state.source,
	);
	state.group.add(capability);
	return createStub(capability, state.destination);
}

function cloneObjectEntries(source: object, target: object, state: CloneState): void {
	for (const key of Object.keys(source)) {
		Reflect.set(target, key, cloneValue(Reflect.get(source, key), state));
	}
}

function cloneValue(value: unknown, state: CloneState): unknown {
	switch (typeof value) {
		case "undefined":
		case "boolean":
		case "number":
		case "string":
		case "bigint":
			return value;
		case "symbol":
			throw new DOMException(`${String(value)} could not be cloned.`, "DataCloneError");
		case "function":
		case "object":
			break;
	}
	if (value === null) return null;
	const object: object = value;
	if (state.seen.has(object)) return state.seen.get(object);
	const remember = <Result>(result: Result): Result => {
		state.seen.set(object, result);
		return result;
	};

	const kind = clientKind(object);
	if (kind === "promise") throw dataCloneError("RpcPromise");
	if (kind === "property") throw dataCloneError("RpcProperty");
	if (kind === "stub") {
		requireOwner(requireClient(object).owner, state.source, "Client");
		const capability = state.duplicateStubs
			? requireClient(object).capability().dup()
			: takeStubCapability(object);
		state.group.add(capability);
		return remember(createStub(capability, state.destination));
	}
	const foreign = foreignStubKind(object);
	if (foreign !== undefined) return remember(foreign.clone?.(object) ?? object);
	if (isProxy(object)) return remember(proxyStub(object, state));
	if (typeof object === "function" || isRpcTarget(object)) {
		const dup: unknown = state.duplicateStubs ? Reflect.get(object, "dup") : undefined;
		const target: unknown =
			typeof dup === "function" ? Reflect.apply(dup, object, []) : object;
		if ((typeof target !== "object" || target === null) && typeof target !== "function") {
			throw new TypeError("dup() must return an object or function.");
		}
		const capability = LocalCapability.for(
			target,
			{ allowInstanceProperties: typeof target === "function", reserved: stubReservedNames },
			state.source,
		);
		state.group.add(capability);
		return remember(createStub(capability, state.destination));
	}

	if (object instanceof Socket) return remember(transferSocket(object));
	if (object instanceof ReadableStream) return remember(transferReadable(object));
	if (object instanceof WritableStream) return remember(transferWritable(object));
	if (object instanceof Request) return remember(new Request(object));
	// An error response has status 0, which the Response constructor rejects.
	if (object instanceof Response) {
		return remember(object.type === "error" ? Response.error() : new Response(object.body, object));
	}
	if (object instanceof Headers) return remember(new Headers(object));
	if (object instanceof Blob) return object;
	if (object instanceof AbortSignal) return remember(transferSignal(object, state));
	if (object instanceof Error) return cloneError(object, state, false);
	if (object instanceof Date) return remember(new Date(object.getTime()));
	if (object instanceof RegExp) return remember(new RegExp(object.source, object.flags));
	if (object instanceof ArrayBuffer) return remember(object.slice(0));
	if (object instanceof SharedArrayBuffer) return object;
	if (ArrayBuffer.isView(object)) return remember(cloneView(object, state));
	if (object instanceof Map) {
		const copy = remember(new Map<unknown, unknown>());
		for (const [key, entry] of object) copy.set(cloneValue(key, state), cloneValue(entry, state));
		return copy;
	}
	if (object instanceof Set) {
		const copy = remember(new Set<unknown>());
		for (const entry of object) copy.add(cloneValue(entry, state));
		return copy;
	}
	if (Array.isArray(object)) {
		const copy = remember(new Array<unknown>(object.length));
		cloneObjectEntries(object, copy, state);
		return copy;
	}
	if (
		object instanceof Boolean ||
		object instanceof Number ||
		object instanceof String ||
		object instanceof BigInt
	) {
		return remember(structuredClone(object));
	}
	if (isPlainObject(object)) {
		const copy = remember({});
		cloneObjectEntries(object, copy, state);
		return copy;
	}
	throw dataCloneError(constructorName(object));
}
