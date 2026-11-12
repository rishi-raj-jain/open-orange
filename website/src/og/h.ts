// A tiny element builder for Satori, so the cards need no JSX runtime.
// `h('div', { display: 'flex' }, 'text', h('img', { width: 40 }, { src }))`
// is <div style="display:flex">text<img style="width:40px" src="…"></div>.
// Satori needs `display: 'flex'` on every element with more than one child.

export type Style = Record<string, string | number>;
export type Node = { type: string; props: { style?: Style; children?: Child | Child[]; [key: string]: unknown } } | string;
type Child = Node | null | false | undefined;

export function h(type: string, style: Style = {}, ...rest: (Child | Record<string, unknown>)[]): Node {
	// A plain object right after the style holds attributes, such as an image's src.
	const attrs = rest.length && isAttrs(rest[0]) ? (rest.shift() as Record<string, unknown>) : {};
	const children = (rest as Child[]).filter((c): c is Node => c !== null && c !== false && c !== undefined);
	return { type, props: { ...attrs, style, children: children.length === 1 ? children[0] : children } };
}

function isAttrs(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !('type' in value && 'props' in value);
}

/** An inline SVG string as an image source. */
export const svgSrc = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
