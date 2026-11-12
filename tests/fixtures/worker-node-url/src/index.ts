import url from "node:url";

export default {
	fetch(): Response {
		const address = new URL("postgres://admin:secret@db.example.com:5432/app?sslmode=require#primary");
		return Response.json({
			format: url.format(address),
			withoutAuth: url.format(address, { auth: false }),
			withoutFragment: url.format(address, { fragment: false }),
			isNodeURL: address instanceof url.URL,
		});
	},
};
