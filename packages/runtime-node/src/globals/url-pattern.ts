import { NodeURLPattern } from "./node-web.js";

type URLPatternComponentResult = URLPatternResult["protocol"];

function withoutUndefinedFields(input: object): object {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function copyComponent(component: URLPatternComponentResult): URLPatternComponentResult {
	return { input: component.input, groups: { ...component.groups } };
}

// workerd returns ordinary objects, and an input dictionary keeps only the
// fields that were given. Node.js returns null-prototype objects and copies
// every URLPatternInit field, including undefined ones.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/urlpattern-standard.c%2B%2B#L136-L160
function workerdResult(result: URLPatternResult): URLPatternResult {
	return {
		inputs: result.inputs.map((input) =>
			typeof input === "object" && input !== null ? withoutUndefinedFields(input) : input,
		),
		protocol: copyComponent(result.protocol),
		username: copyComponent(result.username),
		password: copyComponent(result.password),
		hostname: copyComponent(result.hostname),
		port: copyComponent(result.port),
		pathname: copyComponent(result.pathname),
		search: copyComponent(result.search),
		hash: copyComponent(result.hash),
	};
}

export class URLPattern extends NodeURLPattern {
	override exec(input?: string | URLPatternInit, baseURL?: string): URLPatternResult | null {
		const result = super.exec(input, baseURL);
		return result === null ? null : workerdResult(result);
	}
}
