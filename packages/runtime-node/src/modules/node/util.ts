// esbuild's code splitting drops a star re-export of an external module when the re-exporting
// module is shared by several entries. Each entry re-exports `node:util` itself, and names the
// Orange additions explicitly so they take precedence over the star.
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
