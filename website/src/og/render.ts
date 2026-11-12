// Renders an Open Graph card (src/og/cards.ts) to a PNG: Satori lays the card
// out as an SVG, resvg rasterizes it. Runs at build time from the endpoints in
// src/pages/og*, and live under `pnpm dev`. See website/OG.md.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import satori, { type Font } from 'satori';
import sharp from 'sharp';
import type { Node } from './h';
import { brokenBoxSvg, VIEW } from './shatter';

// Astro runs with the website directory as its working directory (`pnpm --dir
// website build`). Bundled endpoint chunks move, so paths start from there,
// not from this file.
const ROOT = process.cwd();
const require = createRequire(join(ROOT, 'package.json'));

/** Static Inter instances: Satori reads neither WOFF2 nor variable fonts, so these come from @fontsource/inter. */
function loadFonts(): Font[] {
	return ([400, 500, 600] as const).map((weight) => ({
		name: 'Inter',
		weight,
		style: 'normal',
		data: readFileSync(require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`)),
	}));
}

const dataUri = (type: string, data: Buffer) => `data:${type};base64,${data.toString('base64')}`;

/** A file from website/public as a data URI. resvg can't decode WebP, so WebP is converted to PNG, scaled to `width`. */
async function publicImage(path: string, width?: number): Promise<string> {
	const file = join(ROOT, 'public', path);
	if (path.endsWith('.webp') || width) {
		const png = await sharp(file).resize(width ? { width } : undefined).png().toBuffer();
		return dataUri('image/png', png);
	}
	return dataUri(path.endsWith('.svg') ? 'image/svg+xml' : 'image/png', readFileSync(file));
}

/** Renders the broken box once per build, at the photo's own scale. */
async function brokenBox(): Promise<string> {
	const svg = brokenBoxSvg({
		open: await publicImage('images/break-glass-open.webp'),
		pane: await publicImage('images/break-glass-pane.webp'),
		hammer: await publicImage('images/hammer.webp'),
	});
	const png = new Resvg(svg, { fitTo: { mode: 'width', value: VIEW.w }, font: { loadSystemFonts: false } }).render().asPng();
	return dataUri('image/png', png);
}

export type Assets = {
	/** The OpenOrange mark, website/public/images/logo.png. */
	logo: string;
	/** The break-glass box with the orange, as on the home page hero. */
	box: string;
	/** The hammer that hangs beside the box. */
	hammer: string;
	/** The box just after the hammer breaks the glass (src/og/shatter.ts), VIEW.w × VIEW.h photo pixels. */
	brokenBox: string;
};

let cache: Promise<{ fonts: Font[]; assets: Assets }> | undefined;
function load() {
	cache ??= (async () => ({
		fonts: loadFonts(),
		assets: {
			logo: await publicImage('images/logo.png'),
			// 2x the largest size a card draws them at.
			box: await publicImage('images/break-glass.webp', 900),
			hammer: await publicImage('images/hammer.webp'),
			brokenBox: await brokenBox(),
		},
	}))();
	return cache;
}

export type Size = { width: number; height: number };
export const OG_SIZE: Size = { width: 1200, height: 630 };
/** GitHub's recommended social preview size. */
export const GITHUB_SIZE: Size = { width: 1280, height: 640 };

/** Renders `card` (built with the loaded assets) to a PNG of `size`. */
export async function renderPng(card: (assets: Assets, size: Size) => Node, size: Size = OG_SIZE): Promise<Buffer> {
	const { fonts, assets } = await load();
	const svg = await satori(card(assets, size) as Parameters<typeof satori>[0], { ...size, fonts });
	const png = new Resvg(svg, { fitTo: { mode: 'width', value: size.width }, font: { loadSystemFonts: false } }).render().asPng();
	// resvg writes fast, large PNGs; sharp recompresses them losslessly.
	return sharp(png).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

/** A PNG endpoint response. */
export const pngResponse = (png: Buffer) => new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
