import { greeting } from "./greeting";

export default {
	fetch(): Response {
		return new Response(greeting);
	},
};
