import { Buffer } from "node:buffer";
import nodeUtil, { format } from "node:util";

// Node.js 23 removed these deprecated helpers. workerd still provides them, so Worker code that
// calls them keeps working.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/util.ts#L58-L100
export const isBoolean = (val: unknown): boolean => typeof val === "boolean";
export const isBuffer = (val: unknown): boolean => Buffer.isBuffer(val);
export const isDate = (val: unknown): boolean => val instanceof Date;
export const isError = (val: unknown): boolean =>
	nodeUtil.types.isNativeError(val);
export const isFunction = (val: unknown): boolean => typeof val === "function";
export const isNull = (val: unknown): boolean => val === null;
export const isNullOrUndefined = (val: unknown): boolean => val == null;
export const isNumber = (val: unknown): boolean => typeof val === "number";
export const isObject = (val: unknown): boolean =>
	val != null && typeof val === "object";
export const isPrimitive = (val: unknown): boolean =>
	val === null || (typeof val !== "object" && typeof val !== "function");
export const isRegExp = (val: unknown): boolean => val instanceof RegExp;
export const isString = (val: unknown): boolean => typeof val === "string";
export const isSymbol = (val: unknown): boolean => typeof val === "symbol";
export const isUndefined = (val: unknown): boolean => val === undefined;

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/util.ts#L222-L240
const months = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function pad(n: number): string {
	return `${n}`.padStart(2, "0");
}

function timestamp(): string {
	const d = new Date();
	const t = [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join(
		":",
	);
	return `${d.getDate()} ${months[d.getMonth()]} ${t}`;
}

export function log(...args: unknown[]): void {
	console.log("%s - %s", timestamp(), format(...args));
}

export default {
	...nodeUtil,
	isBoolean,
	isBuffer,
	isDate,
	isError,
	isFunction,
	isNull,
	isNullOrUndefined,
	isNumber,
	isObject,
	isPrimitive,
	isRegExp,
	isString,
	isSymbol,
	isUndefined,
	log,
};
