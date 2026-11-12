// Site routes for the repository docs. The repo keeps binding docs under
// docs/modules/; the site files them under /docs/bindings/, Cloudflare's term.
// Used by the sidebar, the page generator and the link rewriter, so the three
// always agree. Plain module: no astro:content import, so astro.config can load it.

/** Collection id (path under docs/ without extension) → site route. */
export function docRoute(id: string): string {
	const clean = id.replace(/(^|\/)index$/, '');
	if (clean === '') return '/docs/';
	// docs/modules/index.mdx only lists the binding docs; the Bindings status page replaces it.
	if (clean === 'modules') return '/docs/bindings/';
	if (clean === 'modules/bindings') return '/docs/bindings/configuration/';
	if (clean.startsWith('modules/')) return `/docs/bindings/${clean.slice('modules/'.length)}/`;
	return `/docs/${clean}/`;
}

/** Ids that have no page of their own (their route belongs to another page). */
export const NO_PAGE = new Set(['modules']);
