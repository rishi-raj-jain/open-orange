import {
	getCapnWebRpcStubConstructor,
	inheritCapnWebRpcTarget,
} from "./capnweb.js";
import type {
	DurableObjectRpcStub,
	DurableObjectRpcStubable,
} from "../namespace.js";

export abstract class RpcTarget {
	declare protected readonly __openOrangeRpcTargetBrand: true;
}

// Workerd exposes RpcTarget and RpcStub from cloudflare:workers. RpcTarget is a
// pass-by-reference capability and RpcStub owns a releasable reference to it:
// https://github.com/cloudflare/workerd/blob/dc27e996c4ab8e8849cc6229ae816b3d426f08ef/types/defines/rpc.d.ts#L201-L208
inheritCapnWebRpcTarget(RpcTarget);

export { RpcTarget as DurableObjectRpcTarget };

export type RpcStub<T extends DurableObjectRpcStubable> =
	DurableObjectRpcStub<T>;

export interface RpcStubConstructor {
	new <T extends DurableObjectRpcStubable>(value: T): RpcStub<T>;
}

function createRpcStubConstructor(): RpcStubConstructor;
function createRpcStubConstructor(): Function {
	// Cap'n Web supplies the matching local stub constructor and disposal
	// behavior; Orange narrows the result to the Workers-facing type above.
	// https://github.com/cloudflare/capnweb/blob/770eec594df59bc44b5e45582f20ed91ea9ffb60/src/core.ts#L493-L527
	return getCapnWebRpcStubConstructor();
}

export const RpcStub = createRpcStubConstructor();
