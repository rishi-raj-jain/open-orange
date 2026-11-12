export default {
	fetch() {
		return new Response(String(process.env.NODE_ENV));
	},
};
