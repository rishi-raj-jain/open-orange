import nodeZlib from "node:zlib";

import { installNodePolyfills } from "../../globals/node-polyfills.js";

installNodePolyfills();

export * from "node:zlib";

// workerd's crc32 also accepts an ArrayBuffer. Node.js accepts only a string or an
// ArrayBufferView and throws for an ArrayBuffer.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/node/zlib-util.h#L354-L358
export function crc32(
	data: string | NodeJS.ArrayBufferView | ArrayBuffer,
	value?: number,
): number {
	return nodeZlib.crc32(
		data instanceof ArrayBuffer ? new Uint8Array(data) : data,
		value,
	);
}

// Node.js defines the legacy `Z_*` constants as non-enumerable properties, so a spread would drop
// them.
const nodeZlibExports: Record<string, unknown> = {};
for (const key of Object.getOwnPropertyNames(nodeZlib)) {
	nodeZlibExports[key] = Reflect.get(nodeZlib, key);
}

export default { ...nodeZlibExports, crc32 };
