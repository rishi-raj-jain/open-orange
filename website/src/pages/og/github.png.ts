// The GitHub social preview, 1280×640: the site-wide card at GitHub's size.
// Upload it by hand under the repository's Settings → General → Social preview
// (see website/OG.md); GitHub has no API for it.
import type { APIRoute } from 'astro';
import { siteCard } from '@/og/cards';
import { GITHUB_SIZE, pngResponse, renderPng } from '@/og/render';

export const GET: APIRoute = async () => pngResponse(await renderPng(siteCard, GITHUB_SIZE));
