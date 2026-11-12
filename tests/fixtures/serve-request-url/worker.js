export default {
	fetch(request) {
		return Response.json({ url: request.url });
	},
};
