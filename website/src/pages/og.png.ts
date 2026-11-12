// The site-wide Open Graph image, 1200×630. Template: src/og/cards.ts.
import type { APIRoute } from 'astro';
import { siteCard } from '@/og/cards';
import { pngResponse, renderPng } from '@/og/render';

export const GET: APIRoute = async () => pngResponse(await renderPng(siteCard));
