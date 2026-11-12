import { value } from "my-alias";

export default {
	fetch() {
		return new Response(value);
	},
};
