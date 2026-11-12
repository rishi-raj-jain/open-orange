import { DurableObject, RpcStub, RpcTarget } from "./cloudflare-workers/index.js";

// Lists only the module exports claimed in cloudflare-conformance/support.json. The
// generated type checks require these keys to match the claims exactly; the runtime
// module itself exports more.
export const moduleImplementations = {
	"cloudflare:workers": {
		DurableObject,
		RpcStub,
		RpcTarget,
	},
};
