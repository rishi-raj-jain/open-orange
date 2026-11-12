import { defineConfig, passthroughImageService } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { remarkDocs, shellSession } from './src/components/docs/remark-docs';
import { PLACEHOLDER_COMPARISONS } from './src/data/site';

// Pages that are noindex (src/layouts/Base.astro) stay out of the sitemap too.
const NOINDEX = new Set(PLACEHOLDER_COMPARISONS.map(({ slug }) => `https://openorange.dev/vs-${slug}/`));

// Standalone site. It intentionally does not import anything from the Rivet
// website so it can be split into its own repository (`git subtree split
// --prefix openorange`) and deployed to its own domain.
export default defineConfig({
	site: 'https://openorange.dev',
	trailingSlash: 'always',
	// Old routes that moved. Static builds write a page that sends the browser on.
	redirects: {
		'/architecture/': '/docs/architecture/',
	},
	// Dev only: let the Amp orb portal proxy reach the dev server. This must be
	// Astro's `server`, not `vite.server`: Astro overwrites Vite's allowedHosts
	// with its own (default `[]`).
	server: { allowedHosts: true },
	// The only processed images are the docs' SVG figures, which need no resizing,
	// so skip sharp.
	image: { service: passthroughImageService() },
	// The /docs/ pages render the repository's docs/*.mdx (see src/content.config.ts).
	integrations: [
		mdx({
			remarkPlugins: [remarkDocs],
			shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' }, transformers: [shellSession] },
		}),
		// /sitemap-index.xml, listed in public/robots.txt.
		sitemap({ filter: (page) => !NOINDEX.has(page) }),
	],
	vite: {
		plugins: [tailwindcss()],
		// The docs and their images live in the parent repository.
		server: { fs: { allow: ['..'] } },
	},
});
