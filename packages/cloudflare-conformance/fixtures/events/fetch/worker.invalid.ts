const worker: ExportedHandler = {
	async fetch() {
		return "not a Response";
	},
};

export default worker;
