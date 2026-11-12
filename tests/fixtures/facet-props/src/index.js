import { DurableObject } from "cloudflare:workers";

export class Greeter extends DurableObject {
	props() {
		return this.ctx.props;
	}
}

const settle = async (run) => {
	try {
		return { value: await run() };
	} catch (error) {
		return { error: `${error.name}: ${error.message}` };
	}
};

export class Parent extends DurableObject {
	async probe() {
		const greeter = this.ctx.exports.Greeter;
		const facetProps = (name, cls) => this.ctx.facets.get(name, () => ({ class: cls })).props();
		return {
			parentProps: this.ctx.props,
			greeterType: typeof greeter,
			greeterTag: Object.prototype.toString.call(greeter),
			calledTag: Object.prototype.toString.call(greeter({ props: { greeting: "Hi" } })),
			bare: await settle(() => facetProps("bare", greeter)),
			withProps: await settle(() => facetProps("with", greeter({ props: { greeting: "Hi", n: 1 } }))),
			calledEmpty: await settle(() => facetProps("empty", greeter({}))),
			calledNoArgument: await settle(() => greeter()),
			uncloneableProps: await settle(() => greeter({ props: { f: () => 1 } })),
			constructed: await settle(() => new greeter()),
		};
	}
}

export default {
	async fetch(request, env) {
		return Response.json(await env.PARENT.getByName("parent").probe());
	},
};
