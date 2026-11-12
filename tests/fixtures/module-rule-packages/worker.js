import packaged from "wasm-pkg/add.wasm";
import blob from "wasm-pkg/blob.bin";
import local from "./local.wasm";

export default {
	async fetch() {
		const fromPackage = (await WebAssembly.instantiate(packaged)).exports.add(2, 3);
		const fromProject = (await WebAssembly.instantiate(local)).exports.add(10, 20);
		return Response.json({ fromPackage, fromProject, blob: [...new Uint8Array(blob)] });
	},
};
