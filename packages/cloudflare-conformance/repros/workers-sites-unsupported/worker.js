import manifest from "__STATIC_CONTENT_MANIFEST";

export default {
	async fetch(request, env) {
		const key = JSON.parse(manifest)["hello.txt"];
		return new Response(await env.__STATIC_CONTENT.get(key));
	},
};
