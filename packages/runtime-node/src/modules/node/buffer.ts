import nodeBuffer from "node:buffer";

import { Blob } from "../../globals/native.js";

export * from "node:buffer";

// `node:buffer` exports the global Blob class on Cloudflare and on Node.js. Orange replaces the
// global Blob, so the module exports the replacement to keep the two the same class.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/node/tests/node-compat-v2-test.js#L85-L86
export { Blob };

export default { ...nodeBuffer, Blob };
