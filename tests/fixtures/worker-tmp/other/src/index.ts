import { readdirSync, writeFileSync } from "node:fs";

export default {
	fetch(): Response {
		const seen = readdirSync("/tmp");
		writeFileSync("/tmp/other.txt", "other");
		return Response.json(seen);
	},
};
