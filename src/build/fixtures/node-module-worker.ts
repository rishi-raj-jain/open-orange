import util from "util";
// @ts-expect-error @types/node no longer declares util.isBoolean.
import prefixedUtil, { isBoolean } from "node:util";

export const sameModule = util === prefixedUtil;

// Node.js 23 removed util.isBoolean, but Workers can still call it on Cloudflare.
export const keptHelper = isBoolean(false);
