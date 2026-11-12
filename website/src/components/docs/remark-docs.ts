// Adapts the repository docs (`../docs/**/*.mdx`) for the /docs/ pages without
// editing them, because the same files are read on GitHub:
// - The leading `# Title` is dropped. The page header renders the frontmatter
//   title and description instead.
// - Relative links to other docs become site routes (see routes.ts): `./kv`
//   and `kv.mdx` from docs/modules/ become `/docs/bindings/kv/`. Relative
//   links to other repository files go to GitHub.
// - An HTML `<img>` or `<picture>` with a relative `src` becomes a Markdown
//   image, so Astro bundles the file like `![](../images/x.svg)`. A block
//   `<picture>` with a `prefers-color-scheme: dark` source becomes two images,
//   shown by the site's theme (`.docs-light` and `.docs-dark` in prose.css).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docRoute } from './routes';

type Attribute = { type: string; name?: string; value?: unknown };
type Node = {
	type: string;
	depth?: number;
	url?: string;
	alt?: string;
	name?: string | null;
	attributes?: Attribute[];
	children?: Node[];
	data?: { hProperties?: Record<string, unknown> };
};
type File = { path?: string; history?: string[] };

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const GITHUB_BLOB = 'https://github.com/rivet-dev/open-orange/blob/main/';

const isRelative = (url: string) => !/^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(url);

/** The site route for a docs-relative file path such as `modules/index.mdx`. */
function docsRoute(relative: string): string {
	return docRoute(relative.replace(/\.mdx?$/, ''));
}

function rewriteLink(url: string, fromDir: string): string {
	if (!isRelative(url)) return url;
	const [, target, suffix] = /^([^?#]*)(.*)$/.exec(url)!;
	if (!target) return url;
	const absolute = path.resolve(fromDir, target);
	const fromRepo = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
	if (fromRepo.startsWith('..')) return url;
	const fromDocs = path.relative(DOCS_DIR, absolute).split(path.sep).join('/');
	// Docs link to each other without an extension (`./kv`), or with `.mdx`.
	if (!fromDocs.startsWith('..') && (/\.mdx?$/.test(fromDocs) || !path.extname(fromDocs))) return `${docsRoute(fromDocs)}${suffix}`;
	return `${GITHUB_BLOB}${fromRepo}${suffix}`;
}

const attribute = (node: Node, name: string) => {
	const value = node.attributes?.find((a) => a.name === name)?.value;
	return typeof value === 'string' ? value : undefined;
};

const isJsx = (node: Node) => node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement';

/** Markdown images for a JSX `<img>` or `<picture>` with a relative source. */
function toImages(node: Node): Node[] | undefined {
	if (!isJsx(node)) return;
	const img = node.name === 'img' ? node : node.name === 'picture' ? node.children?.find((child) => isJsx(child) && child.name === 'img') : undefined;
	const src = img && attribute(img, 'src');
	if (!img || !src || !isRelative(src)) return;
	const alt = attribute(img, 'alt') ?? '';
	const image: Node = { type: 'image', url: src, alt };
	if (node.type !== 'mdxJsxFlowElement') return [image];
	const dark = node.name === 'picture'
		? node.children?.find((child) => isJsx(child) && child.name === 'source' && /prefers-color-scheme:\s*dark/.test(attribute(child, 'media') ?? ''))
		: undefined;
	const darkSrc = dark && attribute(dark, 'srcset');
	if (!darkSrc || !isRelative(darkSrc)) return [{ type: 'paragraph', children: [image] }];
	const themed = (className: string, url: string): Node => ({
		type: 'paragraph',
		data: { hProperties: { className: [className] } },
		children: [{ type: 'image', url, alt }],
	});
	return [themed('docs-light', src), themed('docs-dark', darkSrc)];
}

function visit(node: Node, fromDir: string) {
	if ((node.type === 'link' || node.type === 'definition') && node.url) node.url = rewriteLink(node.url, fromDir);
	if (isJsx(node)) {
		for (const a of node.attributes ?? []) {
			if (a.name === 'href' && typeof a.value === 'string') a.value = rewriteLink(a.value, fromDir);
		}
	}
	const children = node.children ?? [];
	for (let i = 0; i < children.length; i++) {
		const images = toImages(children[i]);
		if (images) {
			children.splice(i, 1, ...images);
			i += images.length - 1;
		} else visit(children[i], fromDir);
	}
}

export function remarkDocs() {
	return (tree: Node, file: File) => {
		const filePath = file.path ?? file.history?.[0];
		if (!filePath) return;
		const absolute = path.resolve(filePath);
		if (path.relative(DOCS_DIR, absolute).startsWith('..')) return;

		const children = tree.children ?? [];
		const first = children.findIndex((node) => node.type !== 'yaml' && node.type !== 'mdxjsEsm');
		if (first !== -1 && children[first].type === 'heading' && children[first].depth === 1) children.splice(first, 1);

		visit(tree, path.dirname(absolute));
	};
}
