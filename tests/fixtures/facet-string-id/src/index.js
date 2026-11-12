import { DurableObject } from "cloudflare:workers";

export class Child extends DurableObject {
	describe() {
		const id = this.ctx.id;
		return { type: typeof id, id: String(id), name: id?.name ?? null };
	}

	remember(value) {
		this.ctx.storage.kv.put("value", value);
	}

	recall() {
		return this.ctx.storage.kv.get("value") ?? null;
	}

	// A facet without an `id` inherits its parent's ID.
	grandchild() {
		return this.ctx.facets.get("grandchild", () => ({ class: this.ctx.exports.Child })).describe();
	}
}

export class Parent extends DurableObject {
	async probe() {
		const child = (name, id) => this.ctx.facets.get(name, () => ({ class: this.ctx.exports.Child, id }));
		const first = child("a", "first-id");
		const described = await first.describe();
		const grandchild = await first.grandchild();
		await first.remember("kept");
		// A restarted facet takes the ID from its new startup options and keeps its storage.
		this.ctx.facets.abort("a", new Error("restart"));
		const restarted = child("a", "second-id");
		return {
			described,
			grandchild,
			restarted: await restarted.describe(),
			recalled: await restarted.recall(),
			parentIdType: typeof this.ctx.id,
		};
	}
}

export default {
	async fetch(request, env) {
		return Response.json(await env.PARENT.getByName("parent").probe());
	},
};
