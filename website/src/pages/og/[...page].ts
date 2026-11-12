// One Open Graph image per docs page, 1200×630: /docs/bindings/kv/ →
// /og/docs/bindings/kv.png (src/og/paths.ts). Template: docsCard in src/og/cards.ts.
import type { APIRoute, GetStaticPaths } from 'astro';
import { docsCard } from '@/og/cards';
import { docsPages, type DocsPage } from '@/og/docs-pages';
import { docsOgImage } from '@/og/paths';
import { pngResponse, renderPng } from '@/og/render';

export const getStaticPaths = (async () =>
	(await docsPages()).map((page) => ({
		params: { page: docsOgImage(page.path).replace(/^\/og\//, '') },
		props: { page },
	}))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => pngResponse(await renderPng(docsCard((props as { page: DocsPage }).page)));
