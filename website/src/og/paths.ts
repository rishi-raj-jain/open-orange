// Where each page's Open Graph image is published. No astro:content import, so
// layouts can use it freely.

/** The site-wide card, src/pages/og.png.ts. */
export const SITE_OG_IMAGE = '/og.png';

/** A docs route's card, from src/pages/og/[...page].png.ts: `/docs/bindings/kv/` → `/og/docs/bindings/kv.png`. */
export const docsOgImage = (route: string) => `/og${route.replace(/\/$/, '')}.png`;
