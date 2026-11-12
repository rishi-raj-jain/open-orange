// Loaded with `--require` into `orange dev` and its runtime. It stands in for a RivetKit build that
// has no `dist/tsup/common/websocket.cjs`, so Orange cannot make RivetKit open its sockets with `ws`.
const Module = require("node:module");

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request.endsWith("/common/websocket.cjs")) {
		throw Object.assign(new Error(`Cannot find module '${request}'`), { code: "MODULE_NOT_FOUND" });
	}
	return Reflect.apply(resolveFilename, this, [request, ...rest]);
};
