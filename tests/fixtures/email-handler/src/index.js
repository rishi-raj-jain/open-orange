let last = null;

export default {
	fetch(request) {
		return Response.json({ reachedFetch: new URL(request.url).pathname, last });
	},
	async email(message, _env, ctx) {
		const subject = message.headers.get("subject");
		if (subject === "throw") throw new Error("handler failed");
		if (subject === "forward") return await message.forward("c@example.com");
		if (subject === "reply") return await message.reply({});
		if (subject === "reject") {
			message.setReject("not wanted");
			return;
		}
		last = {
			from: message.from,
			to: message.to,
			subject,
			folded: message.headers.get("x-folded"),
			bccHeader: message.headers.get("bcc"),
			rawSize: message.rawSize,
			raw: await new Response(message.raw).text(),
		};
		ctx.waitUntil(Promise.resolve());
	},
};
