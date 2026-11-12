import { defineConfig, passthroughImageService } from 'astro/config';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';
import { remarkDocs } from './src/components/docs/remark-docs';

// Standalone site. It intentionally does not import anything from the Rivet
// website so it can be split into its own repository (`git subtree split
// --prefix openorange`) and deployed to its own domain.
export default defineConfig({
	site: 'https://openorange.dev',
	trailingSlash: 'always',
	// Dev only: let the Amp orb portal proxy reach the dev server. This must be
	// Astro's `server`, not `vite.server`: Astro overwrites Vite's allowedHosts
	// with its own (default `[]`).
	server: { allowedHosts: true },
	// The only processed images are the docs' SVG figures, which need no resizing,
	// so skip sharp.
	image: { service: passthroughImageService() },
	// The /docs/ pages render the repository's docs/*.mdx (see src/content.config.ts).
	integrations: [mdx({ remarkPlugins: [remarkDocs], shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' } } })],
	vite: {
		plugins: [tailwindcss()],
		// The docs and their images live in the parent repository.
		server: { fs: { allow: ['..'] } },
	},
});
