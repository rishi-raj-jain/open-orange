// The value codec for RPC between a parent runtime and a dynamic Worker
// process. It uses the Durable Object RPC graph and external table, but it
// encodes the graph as tagged JSON instead of with node:v8, because both ends
// may run where node:v8 serialization is not native.
//
// Every non-JSON value is an array whose first item is a tag. Strings,
// booleans, null, and finite numbers other than -0 are written as-is. An
// object is written in full the first time it appears and as ["r", id] after
// that, so shared references and cycles survive.

import {
	createTypedView,
	dataCloneError,
	decodeRpcExternals,
	extractRpcGraph,
	hydrateRpcGraph,
	typedViewName,
	type RpcValueDecodeOptions,
	type RpcValueEncodeOptions,
	type RpcValueExternal,
} from "../durable-objects/rpc/codec.js";

export interface LoaderValueEnvelope {
	readonly externals: readonly RpcValueExternal[];
	readonly json: string;
}

type Json = null | boolean | number | string | Json[];

function encodeKeys(source: object, write: (value: unknown) => Json): Json[] {
	const entries: Json[] = [];
	for (const key of Object.keys(source)) {
		entries.push([key, write(Reflect.get(source, key))]);
	}
	return entries;
}

function bytesToBase64(buffer: ArrayBuffer): string {
	return Buffer.from(buffer).toString("base64");
}

function encodeGraph(root: unknown): string {
	const ids = new Map<object, number>();
	const write = (value: unknown): Json => {
		switch (typeof value) {
			case "string":
			case "boolean":
				return value;
			case "undefined":
				return ["u"];
			case "bigint":
				return ["b", value.toString()];
			case "number":
				if (Number.isNaN(value)) return ["n", "NaN"];
				if (Object.is(value, -0)) return ["n", "-0"];
				if (value === Infinity) return ["n", "Infinity"];
				if (value === -Infinity) return ["n", "-Infinity"];
				return value;
			case "object":
				break;
			default:
				throw dataCloneError(`Could not serialize value of type ${typeof value}`);
		}
		if (value === null) return null;
		const seen = ids.get(value);
		if (seen !== undefined) return ["r", seen];
		const id = ids.size;
		ids.set(value, id);
		if (Array.isArray(value)) return ["A", id, value.length, encodeKeys(value, write)];
		if (value instanceof Map) {
			return ["M", id, [...value].map(([key, entry]) => [write(key), write(entry)])];
		}
		if (value instanceof Set) return ["S", id, [...value].map(write)];
		if (value instanceof Date) return ["D", id, write(value.getTime())];
		if (value instanceof RegExp) return ["R", id, value.source, value.flags];
		if (value instanceof ArrayBuffer) return ["B", id, bytesToBase64(value)];
		if (ArrayBuffer.isView(value)) {
			if (!(value.buffer instanceof ArrayBuffer)) {
				throw dataCloneError("SharedArrayBuffer views cannot be sent over dynamic Worker RPC");
			}
			return ["V", id, typedViewName(value), write(value.buffer), value.byteOffset, value.byteLength];
		}
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw dataCloneError("Could not serialize a non-plain object over dynamic Worker RPC");
		}
		return ["O", id, prototype === null ? 1 : 0, encodeKeys(value, write)];
	};
	return JSON.stringify(write(root));
}

function invalid(): DOMException {
	return dataCloneError("Dynamic Worker RPC value is malformed");
}

function decodeGraph(json: string): unknown {
	const objects: unknown[] = [];
	const register = <T>(id: unknown, value: T): T => {
		if (id !== objects.length) throw invalid();
		objects.push(value);
		return value;
	};
	const entries = (raw: unknown): [string, unknown][] => {
		if (!Array.isArray(raw)) throw invalid();
		return raw.map((entry: unknown) => {
			if (!Array.isArray(entry) || typeof entry[0] !== "string") throw invalid();
			return [entry[0], entry[1]];
		});
	};
	const read = (node: unknown): unknown => {
		if (!Array.isArray(node)) {
			if (node === null || typeof node === "string" || typeof node === "boolean" || typeof node === "number") {
				return node;
			}
			throw invalid();
		}
		const tag: unknown = node[0];
		const id: unknown = node[1];
		switch (tag) {
			case "u":
				return undefined;
			case "b":
				if (typeof node[1] !== "string") throw invalid();
				return BigInt(node[1]);
			case "n":
				switch (node[1]) {
					case "NaN":
						return Number.NaN;
					case "-0":
						return -0;
					case "Infinity":
						return Infinity;
					case "-Infinity":
						return -Infinity;
					default:
						throw invalid();
				}
			case "r": {
				if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || id >= objects.length) {
					throw invalid();
				}
				return objects[id];
			}
			case "A": {
				if (typeof node[2] !== "number" || !Number.isSafeInteger(node[2]) || node[2] < 0) throw invalid();
				const array = register(id, new Array<unknown>(node[2]));
				for (const [key, value] of entries(node[3])) {
					Object.defineProperty(array, key, {
						configurable: true,
						enumerable: true,
						value: read(value),
						writable: true,
					});
				}
				return array;
			}
			case "O": {
				const object: object = register(id, node[2] === 1 ? Object.create(null) : {});
				for (const [key, value] of entries(node[3])) {
					Object.defineProperty(object, key, {
						configurable: true,
						enumerable: true,
						value: read(value),
						writable: true,
					});
				}
				return object;
			}
			case "M": {
				const map = register(id, new Map<unknown, unknown>());
				const items: unknown = node[2];
				if (!Array.isArray(items)) throw invalid();
				for (const entry of items) {
					if (!Array.isArray(entry)) throw invalid();
					map.set(read(entry[0]), read(entry[1]));
				}
				return map;
			}
			case "S": {
				const set = register(id, new Set<unknown>());
				const items: unknown = node[2];
				if (!Array.isArray(items)) throw invalid();
				for (const entry of items) set.add(read(entry));
				return set;
			}
			case "D": {
				const time = read(node[2]);
				if (typeof time !== "number") throw invalid();
				return register(id, new Date(time));
			}
			case "R":
				if (typeof node[2] !== "string" || typeof node[3] !== "string") throw invalid();
				return register(id, new RegExp(node[2], node[3]));
			case "B":
				if (typeof node[2] !== "string") throw invalid();
				return register(id, new Uint8Array(Buffer.from(node[2], "base64")).buffer);
			case "V": {
				// The buffer is encoded inside the view, after the view's own id.
				const slot = objects.length;
				register(id, undefined);
				const buffer = read(node[3]);
				const [, , type, , byteOffset, byteLength]: unknown[] = node;
				if (
					!(buffer instanceof ArrayBuffer) ||
					typeof type !== "string" ||
					typeof byteOffset !== "number" ||
					typeof byteLength !== "number"
				) {
					throw invalid();
				}
				const view = createTypedView(type, buffer, byteOffset, byteLength);
				objects[slot] = view;
				return view;
			}
			default:
				throw invalid();
		}
	};
	return read(JSON.parse(json));
}

export function encodeLoaderEnvelope(
	value: unknown,
	options: RpcValueEncodeOptions,
): LoaderValueEnvelope {
	const { externals, graph } = extractRpcGraph(value, options);
	return { externals, json: encodeGraph(graph) };
}

export function decodeLoaderEnvelope(envelope: unknown, options: RpcValueDecodeOptions): unknown {
	if (typeof envelope !== "object" || envelope === null) throw invalid();
	const externals = decodeRpcExternals(Reflect.get(envelope, "externals"));
	const json: unknown = Reflect.get(envelope, "json");
	if (typeof json !== "string") throw invalid();
	let graph: unknown;
	try {
		graph = decodeGraph(json);
	} catch (error) {
		if (error instanceof DOMException) throw error;
		throw invalid();
	}
	if (typeof graph !== "object" || graph === null) throw invalid();
	return hydrateRpcGraph(graph, externals, options);
}
