import { createRequire } from "node:module";

import { Response } from "./http.js";
import { ReadableStream } from "./native.js";

// workerd's HTMLRewriter wraps lol-html. Orange uses the same parser through
// its WebAssembly build, as Miniflare 2 did.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/html-rewriter.h#L20-L120

type Handler = (token: object) => void | Promise<void>;
type HandlerSet = Record<string, Handler | undefined>;

interface RawHTMLRewriter {
	end(): Promise<void>;
	free(): void;
	on(selector: string, handlers: HandlerSet): RawHTMLRewriter;
	onDocument(handlers: HandlerSet): RawHTMLRewriter;
	write(chunk: Uint8Array): Promise<void>;
}

type RawHTMLRewriterConstructor = new (
	sink: (chunk: Uint8Array) => void,
	options?: { enableEsiTags?: boolean },
) => RawHTMLRewriter;

let rawConstructor: RawHTMLRewriterConstructor | undefined;

function loadRawHTMLRewriter(): RawHTMLRewriterConstructor {
	if (rawConstructor !== undefined) return rawConstructor;
	const module: unknown = createRequire(import.meta.url)("html-rewriter-wasm");
	const constructor: unknown =
		typeof module === "object" && module !== null
			? Reflect.get(module, "HTMLRewriter")
			: undefined;
	if (typeof constructor !== "function") {
		throw new Error("html-rewriter-wasm does not export HTMLRewriter");
	}
	// SAFETY: html-rewriter-wasm is loaded lazily through require, which returns an untyped
	// value. The check above proves it is a function, and the package exports the
	// lol-html HTMLRewriter class with this constructor and method shape.
	rawConstructor = constructor as RawHTMLRewriterConstructor;
	return rawConstructor;
}

function isIterable(value: unknown): value is Iterable<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, Symbol.iterator) === "function"
	);
}

const contentMethods: ReadonlySet<string> = new Set([
	"after",
	"append",
	"before",
	"prepend",
	"replace",
	"setInnerContent",
]);

// Workerd rejects replacement content with an invalid UTF-8 sequence, and its stream end drops
// an incomplete trailing sequence without an error.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/html-rewriter.c%2B%2B#L636-L667
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/html-rewriter.c%2B%2B#L86-L94
async function readContent(content: ReadableStream<Uint8Array> | Response): Promise<string> {
	const stream = content instanceof Response ? content.body : content;
	if (stream === null) return "";
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text = "";
	for await (const chunk of stream) {
		try {
			text += decoder.decode(chunk, { stream: true });
		} catch {
			throw new TypeError("Parser error: Invalid UTF-8");
		}
	}
	return text;
}

// Attribute iterators inherit from %IteratorPrototype%, like workerd's.
const attributesIteratorPrototype: object = Object.create(
	Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())),
);

const attributesModifiedMessage =
	"The attributes of this element have been modified during iteration. You must create a new iterator after modifying attributes.";
const deadTokenMessage =
	"This content token is no longer valid. Content tokens are only valid during the execution of the relevant content handler.";

interface WrappedToken {
	/** Marks the end of the handler that received the token. */
	end(): void;
	proxy: object;
}

// workerd hands each handler a fresh token object, accepts streams as
// content, and invalidates attribute iterators when attributes change. Once the
// handler ends, an iterator reports the dead token instead of the change.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/html-rewriter.c%2B%2B#L400-L520
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/html-rewriter.c%2B%2B#L1018-L1053
function wrapToken(
	token: object,
	pending: (() => Promise<void>)[],
	state: RewriteState,
): WrappedToken {
	const expandos = new Map<PropertyKey, unknown>();
	let attributesVersion = 0;
	let ended = false;
	const proxy: object = new Proxy(token, {
		get(target, property): unknown {
			if (expandos.has(property)) return expandos.get(property);
			if (property === "attributes") {
				const version = attributesVersion;
				const iterable: unknown = Reflect.get(target, property);
				if (!isIterable(iterable)) {
					throw new TypeError("HTMLRewriter element attributes are not iterable");
				}
				const iterator = iterable[Symbol.iterator]();
				const attributes: object = Object.create(attributesIteratorPrototype);
				Object.defineProperty(attributes, "next", {
					value(): IteratorResult<unknown> {
						if (ended) {
							throw new TypeError(deadTokenMessage);
						}
						if (version !== attributesVersion) {
							throw new TypeError(attributesModifiedMessage);
						}
						return iterator.next();
					},
				});
				return attributes;
			}
			const value: unknown = Reflect.get(target, property);
			if (typeof value !== "function") return value;
			if (property === "setAttribute" || property === "removeAttribute") {
				return (...args: unknown[]): object => {
					attributesVersion += 1;
					Reflect.apply(value, target, args);
					return proxy;
				};
			}
			if (typeof property === "string" && contentMethods.has(property)) {
				return (content: unknown, options?: object): object => {
					if (typeof content === "string") {
						Reflect.apply(value, target, [content, options]);
					} else if (content instanceof ReadableStream || content instanceof Response) {
						pending.push(async () => {
							Reflect.apply(value, target, [await readContent(content), options]);
						});
					} else {
						Reflect.apply(value, target, [String(content), options]);
					}
					return proxy;
				};
			}
			if (property === "onEndTag") {
				return (handler: Handler): void => {
					Reflect.apply(value, target, [wrapHandler({ handler }, "handler", state)]);
				};
			}
			return (...args: unknown[]): unknown => {
				const result: unknown = Reflect.apply(value, target, args);
				return result === target ? proxy : result;
			};
		},
		set(target, property, value): boolean {
			if (property in target) return Reflect.set(target, property, value);
			expandos.set(property, value);
			return true;
		},
	});
	return {
		end(): void {
			ended = true;
		},
		proxy,
	};
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof Reflect.get(value, "then") === "function"
	);
}

// The first error a handler throws in one transform. The WebAssembly parser
// can replace it with its own error while it unwinds, so the transform
// reports the handler's error instead.
interface RewriteState {
	handlerError?: { error: unknown };
}

function requireHandlers(handlers: object, names: readonly string[]): void {
	for (const name of names) {
		const handler: unknown = Reflect.get(handlers, name);
		if (handler !== undefined && typeof handler !== "function") {
			throw new TypeError(`HTMLRewriter handler "${name}" must be a function`);
		}
	}
}

function wrapHandler(handlers: object, name: string, state: RewriteState): Handler | undefined {
	const handler: unknown = Reflect.get(handlers, name);
	if (typeof handler !== "function") return undefined;
	const record = (error: unknown): never => {
		state.handlerError ??= { error };
		throw error;
	};
	return (token: object): void | Promise<void> => {
		const pending: (() => Promise<void>)[] = [];
		const wrapped = wrapToken(token, pending, state);
		let result: unknown;
		try {
			result = Reflect.apply(handler, handlers, [wrapped.proxy]);
		} catch (error: unknown) {
			wrapped.end();
			record(error);
		}
		if (pending.length === 0 && !isPromiseLike(result)) {
			wrapped.end();
			return undefined;
		}
		return (async (): Promise<void> => {
			try {
				await result;
				for (const operation of pending) await operation();
			} catch (error: unknown) {
				record(error);
			} finally {
				wrapped.end();
			}
		})();
	};
}

const elementHandlerNames = ["element", "comments", "text"] as const;
const documentHandlerNames = ["doctype", "comments", "text", "end"] as const;

function handlerSet(
	handlers: object,
	names: readonly string[],
	state: RewriteState,
): HandlerSet {
	const result: HandlerSet = {};
	for (const name of names) result[name] = wrapHandler(handlers, name, state);
	return result;
}

function validateEncoding(response: Response): void {
	const contentType = response.headers.get("content-type");
	const charset = contentType?.match(/charset\s*=\s*"?([^";\s]+)/i)?.[1];
	if (charset === undefined) return;
	try {
		new TextDecoder(charset);
	} catch {
		throw new TypeError("Parser error: Unknown character encoding has been provided.");
	}
}

export class HTMLRewriter {
	readonly #documentHandlers: object[] = [];
	readonly #elementHandlers: [string, object][] = [];

	on(selector: string, handlers: object): this {
		requireHandlers(handlers, elementHandlerNames);
		this.#elementHandlers.push([String(selector), handlers]);
		return this;
	}

	onDocument(handlers: object): this {
		requireHandlers(handlers, documentHandlerNames);
		this.#documentHandlers.push(handlers);
		return this;
	}

	transform(response: Response): Response {
		validateEncoding(response);
		const init = {
			headers: response.headers,
			status: response.status,
			statusText: response.statusText,
		};
		const body = response.body;
		if (body === null) return new Response(null, init);
		const RawRewriter = loadRawHTMLRewriter();
		const state: RewriteState = {};
		const reader = body.getReader();
		let rewriter: RawHTMLRewriter | undefined;
		let reading = false;
		let canceled: { reason: unknown } | undefined;
		const release = (): void => {
			const active = rewriter;
			rewriter = undefined;
			active?.free();
		};
		// workerd pumps the source body through the rewriter as soon as
		// transform() returns, so writers to the source do not wait for a reader.
		const pump = async (
			active: RawHTMLRewriter,
			controller: ReadableStreamDefaultController<Uint8Array>,
		): Promise<void> => {
			for (;;) {
				reading = true;
				const result = await reader.read().finally(() => {
					reading = false;
				});
				if (rewriter !== active) {
					if (canceled !== undefined) {
						await reader.cancel(canceled.reason).catch(() => undefined);
					}
					return;
				}
				if (result.done) {
					await active.end();
					release();
					controller.close();
					return;
				}
				await active.write(result.value);
			}
		};
		const output = new ReadableStream<Uint8Array>({
			start: (controller: ReadableStreamDefaultController<Uint8Array>) => {
				const active = new RawRewriter((chunk) => {
					if (chunk.byteLength !== 0) controller.enqueue(chunk.slice());
				});
				rewriter = active;
				for (const [selector, handlers] of this.#elementHandlers) {
					active.on(selector, handlerSet(handlers, elementHandlerNames, state));
				}
				for (const handlers of this.#documentHandlers) {
					active.onDocument(handlerSet(handlers, documentHandlerNames, state));
				}
				pump(active, controller).catch(async (pumpError: unknown) => {
					const error = state.handlerError === undefined ? pumpError : state.handlerError.error;
					try {
						release();
					} catch {
						// The parser may already be unusable after a handler error.
					}
					controller.error(error);
					await reader.cancel(error).catch(() => undefined);
				});
			},
			async cancel(reason: unknown): Promise<void> {
				release();
				// workerd lets the source chunk already being read finish, then cancels
				// the source, so only later writes to it see the reason.
				// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/htmlrewriter-test.js#L897-L913
				if (reading) {
					canceled = { reason };
					return;
				}
				await reader.cancel(reason);
			},
		});
		const transformed = new Response(output, init);
		transformed.headers.delete("content-length");
		return transformed;
	}
}
