// A Worker that reads files through `find_additional_modules`: as read-only files and with a
// dynamic import that the bundler leaves alone.
import { readFileSync } from "node:fs";
import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
	fetch() {
		return new Response("room");
	}
}

export default {
	async fetch() {
		const skill = "./skills/greet.mjs";
		return Response.json({
			file: readFileSync("/bundle/skills/hello.txt", "utf8").trim(),
			imported: (await import(/* @vite-ignore */ skill)).greeting,
		});
	},
};
