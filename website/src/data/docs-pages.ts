// Titles and descriptions of the docs pages written as Astro pages rather than
// repository MDX (see PAGES in src/components/docs/nav.ts). The pages and
// their Open Graph cards (src/og/docs-pages.ts) both read them from here.
import { BINDINGS } from './bindings';
import { SUMMARY, TRUTH, fmt } from './conformance';

const working = BINDINGS.filter((b) => b.product.status !== 'stub').length;

export const DOCS_PAGES: Record<string, { title: string; description: string; metaDescription?: string }> = {
	'/docs/': {
		title: 'Documentation',
		description: 'Run your Cloudflare Workers and Durable Objects on Rivet with no changes to your app code.',
	},
	'/docs/bindings/': {
		title: 'Binding status',
		description: `${working} of ${BINDINGS.length} Cloudflare bindings run on OpenOrange, with the same wrangler.jsonc and the same env. Each binding's page has how it runs, what differs, and the tests behind it.`,
		// Search results cut descriptions at about 160 characters.
		metaDescription: `${working} of ${BINDINGS.length} Cloudflare bindings run on OpenOrange, with the same wrangler.jsonc and the same env: how each one runs and what differs.`,
	},
	'/docs/compatibility/': {
		title: 'Compatibility',
		description: `${fmt(SUMMARY.totals.all.pass)} of ${fmt(SUMMARY.totals.all.total)} Cloudflare Workers conformance tests pass on OpenOrange, in recorded runs of workerd's test suite and ${TRUTH.projects.length} real open-source projects.`,
	},
};
