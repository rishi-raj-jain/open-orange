// `node:sys` is a deprecated alias of `node:util`. See util.ts for why it re-exports directly.
export * from "node:util";
export {
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
	default,
} from "./util-legacy.js";
