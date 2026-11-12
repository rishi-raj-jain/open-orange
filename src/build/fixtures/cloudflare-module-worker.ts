import { DurableObject } from "cloudflare:workers";

export const ObjectClass = DurableObject;

export default {
	fetch(): Response {
		return new Response("ok");
	},
};
