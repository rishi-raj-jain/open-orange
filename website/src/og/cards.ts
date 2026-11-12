// The Open Graph card templates. Edit these to change what link previews show;
// website/OG.md explains how to preview a change.
//
//   siteCard  the site-wide card (/og.png) and the GitHub social preview
//             (/og/github.png): the brand and the home page headline, beside
//             the break-glass box just as the hammer breaks it. It matches the
//             launch graphic.
//   docsCard  one per docs page (/og/docs/….png): the page's title and
//             description beside the same box, above a row of cloud logos
//             (cloudRow).
//
// Copy and numbers come from src/data/site.ts and src/data/clouds.ts, so the
// cards change with the home page. Colors and type follow src/styles/global.css.
import { HERO } from '@/data/site';
import { CLOUDS } from '@/data/clouds';
import { h, svgSrc, type Node } from './h';
import type { Assets, Size } from './render';
import { VIEW } from './shatter';

const C = {
	paper: '#f9f8f7',
	ink: '#1a1918',
	inkSoft: '#44403c',
	inkFaint: '#78716c',
	line: '#e9e6e3',
	orange: '#f26b1d',
	orangeDeep: '#c4500f',
};

/** `[logo] OpenOrange`, as in the site header. */
const brand = (assets: Assets, size: number) =>
	h(
		'div',
		{ display: 'flex', alignItems: 'center', gap: size * 0.4 },
		h('img', { width: size * 1.45, height: size * 1.45 }, { src: assets.logo }),
		h('div', { display: 'flex', fontSize: size, fontWeight: 600, letterSpacing: '-0.01em', color: C.ink }, 'Open', h('span', { color: C.orange }, 'Orange')),
	);

const svgSize = (svg: string) => {
	const box = svg.match(/viewBox="([\d.\s-]+)"/)?.[1].trim().split(/\s+/).map(Number);
	const attr = (name: string) => Number(svg.match(new RegExp(`\\s${name}="([\\d.]+)"`))?.[1]);
	return box ? { w: box[2], h: box[3] } : { w: attr('width'), h: attr('height') };
};

// How large each logo draws relative to a square one, so they carry the same
// visual weight: their areas match, then dense or thin marks are adjusted.
// AWS's thin wordmark reads lighter and Rivet's solid tile heavier.
const OPTICAL: Record<string, number> = { AWS: 1.22, 'Google Cloud': 1, Azure: 1.02, 'Rivet Cloud': 0.88, 'Your servers': 1 };

/**
 * The bottom row of every card: a hairline, then the cloud logos with their
 * names in one line, spread evenly across the card. `size` is a square logo's
 * height; the others are sized to match it optically.
 */
const cloudRow = (size = 34, labelSize = 26) =>
	h(
		'div',
		{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: `2px solid ${C.line}`, paddingTop: 24 },
		...CLOUDS.map((cloud) => {
			const svg = (cloud.ink ? cloud.svg.replaceAll(cloud.ink, C.ink) : cloud.svg).replace(/<!--.*?-->/gs, '');
			const { w, h: ht } = svgSize(svg);
			const height = (size * (OPTICAL[cloud.name] ?? 1)) / Math.sqrt(w / ht);
			return h(
				'div',
				{ display: 'flex', alignItems: 'center', gap: size * 0.34, height: size * 1.2 },
				h('img', { width: (height * w) / ht, height }, { src: svgSrc(svg) }),
				cloud.label && h('div', { fontSize: labelSize, fontWeight: 500, color: C.inkSoft, whiteSpace: 'nowrap' }, cloud.name),
			);
		}),
	);

/** A hanging chain of `links` links, `seg` apart, as in the hero (src/components/BreakGlass.astro). */
const chain = (links: number, seg: number) => {
	const w = seg * 1.6;
	const rings = Array.from({ length: links }, (_, i) => {
		const cy = seg * (i + 0.5);
		// Links alternate face-on rings and edge-on bars.
		return `<ellipse cx="${w / 2}" cy="${cy}" rx="${i % 2 ? seg * 0.1 : seg * 0.32}" ry="${seg * 0.7}" fill="none" stroke="url(#g)" stroke-width="${Math.max(2, seg * 0.2)}"/>`;
	}).join('');
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${seg * links}" viewBox="0 0 ${w} ${seg * links}"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#e2e5e8"/><stop offset=".5" stop-color="#8b9198"/><stop offset="1" stop-color="#565c63"/></linearGradient></defs>${rings}</svg>`;
	return { src: svgSrc(svg), width: w, height: seg * links };
};

// The box photo is 760×1013 with the frame at x 30–632, y 55–903.
const BOX = { w: 760, h: 1013, frame: { l: 30, r: 632, t: 55, b: 903 } };
const HAMMER = { w: 209, h: 560 };

/**
 * The break-glass box, `height` px tall, its top-left corner at (left, top),
 * absolutely positioned like the hero. By default it is the moment the hammer
 * breaks the glass (src/og/shatter.ts); `intact` hangs the hammer beside the
 * whole box instead.
 */
const breakGlass = (assets: Assets, left: number, top: number, height: number, { intact = false } = {}) => {
	const s = height / BOX.h;
	const width = BOX.w * s;
	const f = { l: BOX.frame.l * s, r: BOX.frame.r * s, t: BOX.frame.t * s, b: BOX.frame.b * s };
	// Shadow under the frame, lit from the top left.
	const shadow = h('div', {
		position: 'absolute',
		left: left + f.l,
		top: top + f.t,
		width: f.r - f.l,
		height: f.b - f.t,
		borderRadius: (f.r - f.l) * 0.05,
		boxShadow: `0 ${s * 6}px ${s * 10}px rgba(26,25,24,0.28), ${s * 14}px ${s * 48}px ${s * 70}px rgba(26,25,24,0.3)`,
	});
	if (!intact) {
		// The broken box's image runs past the photo by VIEW, for the shards and the hammer.
		return [shadow, h('img', { position: 'absolute', left: left + VIEW.x * s, top: top + VIEW.y * s, width: VIEW.w * s, height: VIEW.h * s }, { src: assets.brokenBox })];
	}
	// The chain hangs from the frame's right edge, a third down (as in BreakGlass.astro).
	const anchor = { x: left + width * (630 / 760), y: top + height * 0.3 };
	const hammerH = height * 0.4;
	const hammerW = (hammerH * HAMMER.w) / HAMMER.h;
	const links = chain(8, height * 0.026);
	return [
		shadow,
		h('img', { position: 'absolute', left, top, width, height }, { src: assets.box }),
		h('img', { position: 'absolute', left: anchor.x - links.width / 2, top: anchor.y, width: links.width, height: links.height }, { src: links.src }),
		// Head down, handle on the chain.
		h('img', { position: 'absolute', left: anchor.x - hammerW / 2, top: anchor.y + links.height - 3, width: hammerW, height: hammerH, transform: 'rotate(180deg)' }, { src: assets.hammer }),
	];
};

// The site card lays out 1200 wide at the image's aspect ratio (1200×630, or
// 1200×600 for GitHub's 1280×640) and scales to fit, so the headline breaks the
// same way at both sizes.
const SITE_W = 1200;

/**
 * The site-wide card: the brand, the home page headline on two lines, and the
 * box as the hammer breaks it, as in the launch graphic.
 */
export function siteCard(assets: Assets, { width, height }: Size, { intact = false } = {}): Node {
	const k = width / SITE_W;
	const w = SITE_W;
	const ht = Math.round(height / k);
	const boxH = 500;
	const card = h(
		'div',
		{ display: 'flex', position: 'relative', width: w, height: ht, backgroundColor: C.paper, fontFamily: 'Inter', color: C.ink, transform: `scale(${k})`, transformOrigin: 'top left' },
		h(
			'div',
			// 790 wide fits "Workers anywhere." but not a third word, so the headline keeps two lines.
			{ display: 'flex', flexDirection: 'column', justifyContent: 'center', position: 'absolute', left: 72, top: 56, width: 790, height: ht - 56 - 48 },
			brand(assets, 34),
			h('div', { fontSize: 84, fontWeight: 500, lineHeight: 1.03, letterSpacing: '-0.04em', marginTop: 30 }, HERO.title),
		),
		...breakGlass(assets, w - 350, (ht - boxH) / 2, boxH, { intact }),
	);
	return h('div', { display: 'flex', width, height, backgroundColor: C.paper, overflow: 'hidden' }, card);
}

/** Per-page card for the docs: the page title and description beside a smaller box, the clouds along the bottom. */
export function docsCard(page: { title: string; description: string; section?: string }) {
	return (assets: Assets, { width, height }: Size): Node => {
		// Shorter titles set larger; two lines at most.
		const titleSize = page.title.length <= 16 ? 84 : page.title.length <= 26 ? 72 : 58;
		return h(
			'div',
			{ display: 'flex', position: 'relative', width, height, backgroundColor: C.paper, fontFamily: 'Inter', color: C.ink },
			h(
				'div',
				{ display: 'flex', flexDirection: 'column', position: 'absolute', left: 72, top: 60, width: width - 144, height: height - 60 - 50 },
				h('div', { display: 'flex', alignItems: 'center', gap: 18 }, brand(assets, 28), h('div', { fontSize: 28, fontWeight: 400, color: C.inkFaint }, 'Docs')),
				h(
					'div',
					{ display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center', width: 740 },
					page.section && h('div', { fontSize: 26, fontWeight: 600, color: C.orangeDeep, marginBottom: 18 }, page.section),
					h('div', { fontSize: titleSize, fontWeight: 500, lineHeight: 1.05, letterSpacing: '-0.03em', textWrap: 'balance' }, page.title),
					h('div', { fontSize: 30, lineHeight: 1.4, color: C.inkSoft, marginTop: 26, lineClamp: 3 }, page.description),
				),
				// Where it runs, as on the site card.
				cloudRow(),
			),
			...breakGlass(assets, width - 340, 64, 430),
		);
	};
}
