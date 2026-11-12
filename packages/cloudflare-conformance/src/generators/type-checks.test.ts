import assert from "node:assert/strict";
import test from "node:test";

import {
	claimedGlobalNames,
	claimedModuleExports,
	renderGlobalTypeChecks,
} from "./type-checks.js";

test("emits checks only for partial and implemented global claims", () => {
	const names = claimedGlobalNames({
		globals: {
			TextEncoder: { status: "implemented" },
			atob: { status: "partial" },
			ignored: { status: "unimplemented" },
		},
	});
	assert.deepEqual(names, ["TextEncoder", "atob"]);

	const output = renderGlobalTypeChecks(names, ["atob"]);
	assert.match(output, /keyof typeof globalImplementations/);
	assert.match(output, /typeof TextEncoder/);
	assert.match(output, /typeof globalImplementations\["atob"\]/);
	assert.match(output, /IsExact<ActualGlobal0, ExpectedGlobal0>/);
	assert.match(
		output,
		/const partialCompatibility1: ExpectedGlobal1 = partialGlobal1/,
	);
	assert.doesNotMatch(output, /ignored/);
});

test("emits an exact empty-registry check when all globals are placeholders", () => {
	const output = renderGlobalTypeChecks([]);
	assert.match(output, /type ClaimedGlobalNames = never/);
	assert.match(output, /type ClaimedBindingNames = never/);
	assert.match(output, /type ClaimedModuleSpecifiers = never/);
	assert.match(output, /type ClaimedEventNames = never/);
	assert.doesNotMatch(output, /type ExpectedGlobal0/);
});

test("emits exact Durable Object and SQL storage checks", () => {
	const output = renderGlobalTypeChecks([]);
	assert.match(output, /IsExact<OrangeDurableObjectId, DurableObjectId>/);
	assert.match(output, /AlarmInvocationInfoCheck/);
	assert.match(output, /ImplementedDurableObjectStateKeysCheck/);
	assert.match(output, /expectedImplementedDurableObjectStateCompatibility/);
	assert.match(output, /orangeImplementedDurableObjectStateCompatibility/);
	assert.match(output, /DurableObjectPropsCheck/);
	assert.match(output, /SqlStorageValueCheck/);
	assert.match(output, /SqlStorageCursorKeysCheck/);
	assert.match(output, /expectedSqlCursorCompatibility/);
	assert.match(output, /orangeSqlCursorCompatibility/);
	assert.match(output, /SqlStorageKeysCheck/);
	assert.match(output, /expectedSqlStorageCompatibility/);
	assert.match(output, /orangeSqlStorageCompatibility/);
	assert.match(output, /SqlStorageStatementKeysCheck/);
	assert.match(output, /DurableObjectStorageKeysCheck/);
	assert.match(output, /expectedDurableObjectStorageCompatibility/);
	assert.match(output, /orangeDurableObjectStorageCompatibility/);
	assert.match(output, /expectedTransactionSyncCompatibility/);
	assert.match(output, /orangeTransactionSyncCompatibility/);
	assert.match(output, /DurableObjectGetOptionsCheck/);
	assert.match(output, /DurableObjectListOptionsCheck/);
	assert.match(output, /DurableObjectPutOptionsCheck/);
	assert.match(output, /AsyncKvStorageCheck/);
	assert.match(output, /expectedAsyncKvStorageCompatibility/);
	assert.match(output, /orangeAsyncKvStorageCompatibility/);
	assert.match(output, /DurableObjectGetAlarmOptionsCheck/);
	assert.match(output, /DurableObjectSetAlarmOptionsCheck/);
	assert.match(output, /DurableObjectTransactionCheck/);
	assert.match(output, /expectedDurableObjectTransactionCompatibility/);
	assert.match(output, /orangeDurableObjectTransactionCompatibility/);
	assert.match(output, /AsyncTransactionStorageCheck/);
	assert.match(output, /expectedAsyncTransactionStorageCompatibility/);
	assert.match(output, /orangeAsyncTransactionStorageCompatibility/);
	assert.match(output, /SyncKvListOptionsCheck/);
	assert.match(output, /SyncKvStorageKeysCheck/);
	assert.match(output, /expectedSyncKvStorageCompatibility/);
	assert.match(output, /orangeSyncKvStorageCompatibility/);
	assert.match(output, /DurableObjectNamespaceIdSurfaceCheck/);
	assert.match(output, /DurableObjectNamespaceGetParametersCheck/);
	assert.match(output, /DurableObjectNamespaceGetByNameParametersCheck/);
	assert.match(output, /DurableObjectNamespaceJurisdictionParametersCheck/);
	assert.match(output, /DurableObjectStubIdentityCheck/);
	assert.match(output, /DurableObjectStubFetchParametersCheck/);
	assert.match(output, /DurableObjectStubFetchResultCheck/);
	assert.match(output, /DurableObjectStubMethodCheck/);
	assert.match(output, /"add" \| "greet" \| "summary"/);
	assert.match(output, /DurableObjectStreamingParametersCheck/);
	assert.match(output, /DurableObjectStreamingResultCheck/);
	assert.match(output, /DurableObjectStubReservedMethodCheck/);
});

test("extracts direct and namespace-backed cloudflare module exports", () => {
	assert.deepEqual(
		claimedModuleExports({
			modules: {
				direct: {
					status: "implemented",
					declarations: [
						{
							exported: true,
							kind: "class",
							moduleSpecifier: "cloudflare:test",
							name: "Direct",
						},
					],
				},
				namespace: {
					status: "partial",
					declarations: [
						{
							kind: "export-assignment",
							moduleSpecifier: "cloudflare:workers",
							name: "export=",
						},
						{
							exported: true,
							kind: "class",
							name: "DurableObject",
							namespacePath: ["CloudflareWorkersModule"],
						},
					],
				},
			},
		}),
		[
			{
				exportName: "Direct",
				moduleSpecifier: "cloudflare:test",
				status: "implemented",
			},
			{
				exportName: "DurableObject",
				moduleSpecifier: "cloudflare:workers",
				status: "partial",
			},
		],
	);
});

test("emits exact module and export key checks", () => {
	const output = renderGlobalTypeChecks(
		[],
		[],
		[],
		[
			{
				exportName: "connect",
				moduleSpecifier: "cloudflare:sockets",
				status: "implemented",
			},
		],
	);
	assert.match(output, /keyof typeof moduleImplementations/);
	assert.match(output, /typeof import\("cloudflare:sockets"\)\["connect"\]/);
	assert.match(output, /IsExact<ActualModule0Export0, ExpectedModule0Export0>/);
});

test("checks both sides of the nominal Durable Object base class", () => {
	const output = renderGlobalTypeChecks(
		[],
		[],
		[],
		[
			{
				exportName: "DurableObject",
				moduleSpecifier: "cloudflare:workers",
				status: "partial",
			},
		],
	);
	assert.match(output, /ExpectedModule0Export0PublicInstance/);
	assert.match(output, /Rpc\.__DURABLE_OBJECT_BRAND/);
	assert.match(output, /PartialModule0Export0ConstructorProbe/);
	assert.match(output, /ConstructorParameters<ExpectedModule0Export0>/);
});

test("checks the public nominal RPC target and stub surfaces", () => {
	const output = renderGlobalTypeChecks(
		[],
		[],
		[],
		[
			{
				exportName: "RpcStub",
				moduleSpecifier: "cloudflare:workers",
				status: "partial",
			},
			{
				exportName: "RpcTarget",
				moduleSpecifier: "cloudflare:workers",
				status: "partial",
			},
		],
	);
	assert.match(output, /ExpectedRpcStubFixtureTarget/);
	assert.match(output, /RpcStubFixturePublicCheck/);
	assert.match(output, /RpcStubDupParametersCheck/);
	assert.match(output, /RpcStubCallableParametersCheck/);
	assert.match(output, /RpcStubCallableResultCheck/);
	assert.match(output, /Rpc\.__RPC_TARGET_BRAND/);
	assert.match(output, /ActualModule0Export1PublicInstance/);
});

test("emits exact checks for binding factory results", () => {
	const output = renderGlobalTypeChecks(
		[],
		[],
		[{ name: "version_metadata", typeName: "WorkerVersionMetadata" }],
	);
	assert.match(output, /keyof typeof bindingFactories/);
	assert.match(
		output,
		/ReturnType<\(typeof bindingFactories\)\["version_metadata"\]>/,
	);
	assert.match(output, /IsExact<ActualBinding0, ExpectedBinding0>/);
});

test("emits exact-keyed execution context checks", () => {
	const output = renderGlobalTypeChecks(
		[],
		[],
		[],
		[],
		[{ name: "fetch", typeName: "ExecutionContext" }],
	);
	assert.match(output, /keyof typeof eventContextFactories/);
	assert.match(
		output,
		/type ExpectedEventContext0 = ExecutionContext<unknown>/,
	);
	assert.match(
		output,
		/const eventContextCompatibility0: ExpectedEventContext0 = eventContext0/,
	);
});
