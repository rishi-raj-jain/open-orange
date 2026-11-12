export default {
	fetch() {
		return new Response("ok");
	},
	scheduled() {
		console.log("cron ran");
	},
};
