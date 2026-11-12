// Reads a `find_additional_modules` file as a read-only file under /bundle, which `orange serve`
// fills from the files that it finds next to the entrypoint.
import { readFileSync } from "node:fs";

export default {
	fetch() {
		return new Response(readFileSync("/bundle/notes/hello.txt", "utf8"));
	},
};
