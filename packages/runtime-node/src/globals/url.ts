import {
	URL as NodeURL,
	URLSearchParams as NodeURLSearchParams,
} from "node:url";
import { inspect, type InspectOptions } from "node:util";

import { markWorkerdClass } from "./workerd-class.js";

const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

// Gives util.inspect the class name "URL" for the display object.
const URLDisplay = class URL {};

export type URLSearchParamsInit =
	| Iterable<Iterable<string>>
	| Record<string, string>
	| string;

const searchParams = new WeakMap<URLSearchParams, NodeURLSearchParams>();

function searchParamsFor(instance: URLSearchParams): NodeURLSearchParams {
	const value = searchParams.get(instance);
	if (value === undefined) {
		throw new TypeError("Illegal invocation");
	}
	return value;
}

// WebIDL treats an initializer whose @@iterator is undefined or null as a
// record rather than a sequence.
function isSequenceInit(
	init: Exclude<URLSearchParamsInit, string>,
): init is Iterable<Iterable<string>> {
	return typeof Reflect.get(init, Symbol.iterator) === "function";
}

function createSearchParams(init?: URLSearchParamsInit): NodeURLSearchParams {
	const result = new NodeURLSearchParams();
	if (init === undefined) {
		return result;
	}
	if (typeof init === "string") {
		return new NodeURLSearchParams(init);
	}
	if (isSequenceInit(init)) {
		for (const entry of init) {
			const pair = [...entry];
			if (pair.length !== 2 || pair[0] === undefined || pair[1] === undefined) {
				throw new TypeError(
					"Each query parameter pair must contain exactly two items.",
				);
			}
			result.append(pair[0], pair[1]);
		}
		return result;
	}
	for (const [name, value] of Object.entries(init)) {
		result.append(name, value);
	}
	return result;
}

function searchParamsFromNode(value: NodeURLSearchParams): URLSearchParams {
	const result = new URLSearchParams();
	searchParams.set(result, value);
	return result;
}

export class URLSearchParams {
	constructor(init?: URLSearchParamsInit) {
		searchParams.set(this, createSearchParams(init));
	}

	get size(): number {
		return searchParamsFor(this).size;
	}

	append(name: string, value: string): void {
		searchParamsFor(this).append(name, value);
	}

	delete(name: string, value?: string): void {
		searchParamsFor(this).delete(name, value);
	}

	get(name: string): string | null {
		return searchParamsFor(this).get(name);
	}

	getAll(name: string): string[] {
		return searchParamsFor(this).getAll(name);
	}

	has(name: string, value?: string): boolean {
		return searchParamsFor(this).has(name, value);
	}

	set(name: string, value: string): void {
		searchParamsFor(this).set(name, value);
	}

	sort(): void {
		searchParamsFor(this).sort();
	}

	entries(): IterableIterator<[key: string, value: string]> {
		return searchParamsFor(this).entries();
	}

	keys(): IterableIterator<string> {
		return searchParamsFor(this).keys();
	}

	values(): IterableIterator<string> {
		return searchParamsFor(this).values();
	}

	forEach<This = unknown>(
		callback: (
			this: This,
			value: string,
			key: string,
			parent: URLSearchParams,
		) => void,
		thisArg?: This,
	): void {
		for (const [key, value] of this) {
			Reflect.apply(callback, thisArg, [value, key, this]);
		}
	}

	toString(): string {
		return searchParamsFor(this).toString();
	}

	[Symbol.iterator](): IterableIterator<[key: string, value: string]> {
		return this.entries();
	}
}

const urls = new WeakMap<URL, NodeURL>();

function urlFor(instance: URL): NodeURL {
	const value = urls.get(instance);
	if (value === undefined) {
		throw new TypeError("Illegal invocation");
	}
	return value;
}

function urlInput(value: string | URL): string {
	return typeof value === "string" ? value : value.href;
}

function urlFromNode(value: NodeURL): URL {
	const result = new URL(value.href);
	urls.set(result, value);
	return result;
}

export class URL {
	constructor(url: string | URL, base?: string | URL) {
		urls.set(
			this,
			new NodeURL(
				urlInput(url),
				base === undefined ? undefined : urlInput(base),
			),
		);
	}

	get origin(): string {
		return urlFor(this).origin;
	}

	get href(): string {
		return urlFor(this).href;
	}

	set href(value: string) {
		urlFor(this).href = value;
	}

	get protocol(): string {
		return urlFor(this).protocol;
	}

	set protocol(value: string) {
		urlFor(this).protocol = value;
	}

	get username(): string {
		return urlFor(this).username;
	}

	set username(value: string) {
		urlFor(this).username = value;
	}

	get password(): string {
		return urlFor(this).password;
	}

	set password(value: string) {
		urlFor(this).password = value;
	}

	get host(): string {
		return urlFor(this).host;
	}

	set host(value: string) {
		urlFor(this).host = value;
	}

	get hostname(): string {
		return urlFor(this).hostname;
	}

	set hostname(value: string) {
		urlFor(this).hostname = value;
	}

	get port(): string {
		return urlFor(this).port;
	}

	set port(value: string) {
		urlFor(this).port = value;
	}

	get pathname(): string {
		return urlFor(this).pathname;
	}

	set pathname(value: string) {
		urlFor(this).pathname = value;
	}

	get search(): string {
		return urlFor(this).search;
	}

	set search(value: string) {
		urlFor(this).search = value;
	}

	get hash(): string {
		return urlFor(this).hash;
	}

	set hash(value: string) {
		urlFor(this).hash = value;
	}

	get searchParams(): URLSearchParams {
		return searchParamsFromNode(urlFor(this).searchParams);
	}

	toJSON(): string {
		return urlFor(this).toJSON();
	}

	toString(): string {
		return urlFor(this).toString();
	}

	static canParse(url: string, base?: string): boolean {
		return NodeURL.canParse(url, base);
	}

	static parse(url: string, base?: string): URL | null {
		const value = NodeURL.parse(url, base);
		return value === null ? null : urlFromNode(value);
	}

	static createObjectURL(_object: File | Blob): string {
		const error = new Error("URL.createObjectURL is not implemented yet.");
		error.name = "NotSupportedError";
		throw error;
	}

	static revokeObjectURL(object_url: string): void {
		NodeURL.revokeObjectURL(object_url);
	}
}

// Node.js inspect hooks are installed outside the class bodies so they stay out of the
// declared URL and URLSearchParams shapes that Workers code type-checks against.
function defineInspect<Target extends object>(
	prototype: Target,
	hook: (this: Target, depth: number, options: InspectOptions) => string,
): void {
	Object.defineProperty(prototype, inspectCustom, {
		configurable: true,
		enumerable: false,
		value: hook,
		writable: true,
	});
}

defineInspect(URLSearchParams.prototype, function (depth, options) {
	return inspect(searchParamsFor(this), { ...options, depth });
});

// Workerd lists origin first, unlike Node.js, which starts with href.
defineInspect(URL.prototype, function (depth, options) {
	const url = urlFor(this);
	const display = Object.create(URLDisplay.prototype);
	Object.assign(display, {
		origin: url.origin,
		href: url.href,
		protocol: url.protocol,
		username: url.username,
		password: url.password,
		host: url.host,
		hostname: url.hostname,
		port: url.port,
		pathname: url.pathname,
		search: url.search,
		hash: url.hash,
		searchParams: this.searchParams,
	});
	return inspect(display, { ...options, depth });
});

// node:url and other Node.js built-ins check `instanceof URL` against Node's own class, so
// url.format() of a Worker's URL would drop its credentials. Every member of Node's prototype
// is overridden above, so the chain only changes that check.
Object.setPrototypeOf(URL.prototype, NodeURL.prototype);

markWorkerdClass(URL, "URL");
markWorkerdClass(URLSearchParams, "URLSearchParams");
