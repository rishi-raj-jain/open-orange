// The migration scene from the landing page (src/components/Migrate.astro),
// redrawn for the docs: Users, the DNS record, a switch under it, and the
// Cloudflare and OpenOrange boxes with six Durable Objects, A to F.
//
// Everything here is a pure function that returns SVG markup, so the same
// drawing renders at build time (each step's diagram, and the animation's
// frame without JavaScript) and in the browser (the animation's frames).
// Colors are theme tokens, so the scene follows light and dark.
//
// Three drawings: `wide` and `narrow` for the animation (MigrateScene.astro),
// shorter than the landing page's, and `mini` for the state after each step
// (MigrateStep.astro), which adds each side's D1 database.
import cloudflare from '@/assets/migrator/cloudflare.svg?raw';
import rivet from '@/assets/migrator/rivet-white.svg?raw';
import aws from '@/assets/migrator/aws.svg?raw';
import gcp from '@/assets/migrator/gcp.svg?raw';
import azure from '@/assets/migrator/azure.svg?raw';
import refresh from '@/assets/migrator/refresh-cw.svg?raw';
import globe from '@/assets/migrator/globe.svg?raw';
import users from '@/assets/migrator/users.svg?raw';
import database from '@/assets/migrator/database.svg?raw';

type Icon = [viewBox: string, body: string, fill: string | null];
const inner = (svg: string) => svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/)![1].replace(/\s+/g, ' ').trim();
const vbox = (svg: string) => svg.match(/viewBox="([^"]+)"/)![1];
const lucide = (svg: string): Icon => ['0 0 24 24', inner(svg), null];
const ICONS: Record<string, Icon> = {
	cf: [vbox(cloudflare), inner(cloudflare).replace('<title>Cloudflare</title>', ''), '#F6821F'],
	aws: [vbox(aws), inner(aws).replaceAll('#252F3E', 'var(--mig-aws)'), null],
	gcp: [vbox(gcp), inner(gcp), null],
	azure: [vbox(azure), inner(azure), null],
	rivet: ['0 0 128 128', inner(rivet).replace('#0F0F0F', '#1B1916'), null],
	users: lucide(users),
	globe: lucide(globe),
	refresh: lucide(refresh),
	database: lucide(database),
};

// The beats of the animation, as on the landing page. Seconds each holds the scene.
export const BEATS = [
	{ id: 'intro', dur: 3, title: 'Before', body: 'Every request goes to Cloudflare.' },
	{ id: 'cutover', dur: 3.4, title: 'Cutover', body: 'The DNS record now points at OpenOrange. New requests follow it.' },
	{ id: 'lazy', dur: 5.6, title: 'Lazy migration', body: "Each object is copied over the first time it's requested, then served from OpenOrange." },
	{ id: 'backfill', dur: 3.2, title: 'Backfill', body: 'A backfill job copies everything else.' },
	{ id: 'after', dur: 4.6, title: 'Zero downtime', body: 'Every request now runs on OpenOrange. The app stayed up the whole time.' },
] as const;
export type BeatId = (typeof BEATS)[number]['id'];

// Timeline in seconds, as on the landing page.
const PAUSE = 0.4;
export const START: Record<BeatId, number> = {} as Record<BeatId, number>;
const DUR = {} as Record<BeatId, number>;
let acc = 0;
for (const b of BEATS) {
	START[b.id] = acc;
	DUR[b.id] = b.dur;
	acc += b.dur + PAUSE;
}
export const END = acc + 0.4;
const C = START.cutover, LZ = START.lazy, BF = START.backfill, AFTER = START.after;
// The DNS edit: focus the target, select it, clear it, type the new one, save.
// Saving throws the switch.
const NEW = 'openorange', OLD = 'cloudflare', KEY = 0.07;
const FOCUS = C + 0.2, SELECT = C + 0.5, CLEAR = C + 0.95, TYPE = C + 1.05;
const FLIP = TYPE + NEW.length * KEY + 0.3;
const MOVE = 0.8, FAST = 0.3, MED = 0.6;
// A, C and E copy on their first request; B, D and F through the backfill.
const MOVES = [
	{ i: 0, t: LZ + 0.3, bf: false }, { i: 2, t: LZ + 2, bf: false }, { i: 4, t: LZ + 3.6, bf: false },
	{ i: 1, t: BF + 0.5, bf: true }, { i: 3, t: BF + 1.1, bf: true }, { i: 5, t: BF + 1.7, bf: true },
];
const mv = (i: number) => MOVES.find((m) => m.i === i)!;

/** The beat playing at `t`. */
export const beatAt = (t: number): BeatId => {
	let beat: BeatId = BEATS[0].id;
	for (const b of BEATS) if (t >= START[b.id]) beat = b.id;
	return beat;
};
/** A settled frame late in each beat, for reduced motion and the frame without JavaScript. */
export const settled = (k: BeatId) => (k === 'intro' ? START.intro + 1 : k === 'cutover' ? FLIP + 1 : START[k] + DUR[k] * 0.9);

const inOut = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const out = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3));
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

type Box = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };
export type Kind = 'wide' | 'narrow' | 'mini';
type Route = { pts: Pt[]; cum: number[]; len: number; hold: number };
type Req = { t: number; i: number; to: 'cf' | 'nw'; hold?: number };

export type Layout = ReturnType<typeof layout>;

export function layout(kind: Kind) {
	const mini = kind === 'mini', narrow = kind === 'narrow';
	const W = mini ? 300 : narrow ? 344 : 600;
	const CX = W / 2;
	const users = mini ? { x: CX - 34, y: 1, w: 68, h: 20 } : narrow ? { x: CX - 44, y: 4, w: 88, h: 26 } : { x: CX - 46, y: 6, w: 92, h: 28 };
	const dns = mini ? { x: CX - 114, y: 28, w: 228, h: 26 } : narrow ? { x: 8, y: 42, w: W - 16, h: 60 } : { x: CX - 180, y: 52, w: 360, h: 62 };
	// The record: name, type and target, placed by the mono advance (0.6em).
	// The mini record leaves out the header and the type.
	const fs = mini ? 10.5 : narrow ? 11 : 12.5, cw = fs * 0.6;
	const nameX = dns.x + (mini ? 24 : narrow ? 10 : 14);
	const typeX = mini ? null : nameX + 15 * cw + (narrow ? 9 : 16);
	const fieldX = typeX === null ? nameX + 15 * cw + 10 : typeX + 5 * cw + (narrow ? 9 : 16);
	const field = mini
		? { x: fieldX, y: dns.y + 4, w: dns.x + dns.w - 4 - fieldX, h: 18 }
		: { x: fieldX, y: dns.y + (narrow ? 32 : 34), w: dns.x + dns.w - (narrow ? 8 : 12) - fieldX, h: narrow ? 21 : 22 };
	const JY = dns.y + dns.h + (mini ? 12 : narrow ? 22 : 26);
	const by = JY + (mini ? 18 : narrow ? 22 : 28);
	const m = mini ? 1 : narrow ? 8 : 12;
	const gap = mini ? 24 : narrow ? 36 : 64;
	const bw = (W - 2 * m - gap) / 2;
	const T = mini ? 16 : narrow ? 28 : 32, G = mini ? 3 : narrow ? 6 : 7, cols = narrow || mini ? 3 : 6;
	const head = mini ? 22 : narrow ? 32 : 36, pad = mini ? 8 : narrow ? 10 : 14;
	const rows = 6 / cols;
	const bh = head + pad + rows * T + (rows - 1) * G + pad;
	const cf = { x: m, y: by, w: bw, h: bh }, nw = { x: W - m - bw, y: by, w: bw, h: bh };
	const gw = cols * T + (cols - 1) * G, gh = rows * T + (rows - 1) * G;
	const bodyY = by + head + pad;
	// The mini drawing puts each side's D1 database next to the objects, facing
	// the other side, so the line that forwards its queries stays short.
	const d1 = mini ? { w: 24, h: gh, gap: 14 } : null;
	const group = gw + (d1 ? d1.gap + d1.w : 0);
	const left = (b: Box) => b.x + (b.w - group) / 2;
	const origin = {
		cf: { x: left(cf), y: bodyY },
		nw: { x: left(nw) + (d1 ? d1.w + d1.gap : 0), y: bodyY },
	};
	const d1At = d1 ? { cf: { x: left(cf) + gw + d1.gap, y: bodyY }, nw: { x: left(nw), y: bodyY } } : null;
	const bfy = narrow ? bodyY + T + G / 2 : bodyY + gh / 2;
	const H = by + bh + (narrow ? 22 : mini ? 2 : 8);
	const L = {
		kind, mini, narrow, W, H, CX, users, dns, fs, cw, nameX, typeX, field, JY, cf, nw, T, G, cols, head, pad, origin,
		d1: d1 && d1At ? { ...d1, at: d1At } : null,
		// The backfill job sits between the boxes; on phones its label goes under them.
		bf: { x: CX, y: bfy, r: mini ? 9 : narrow ? 11 : 13, labelY: mini ? null : narrow ? by + bh + 15 : bfy + 28 },
		R: mini ? 6 : narrow ? 10 : 12,
		arm: mini ? 12 : narrow ? 16 : 18,
		hold: mini ? 9 : narrow ? 12 : 14,
		rx: mini ? 4 : narrow ? 6 : 7,
		tileFs: mini ? 9.5 : narrow ? 12.5 : 14,
		pulse: narrow ? 6 : 9,
		dot: mini ? 5.5 : narrow ? 6 : 7,
		speed: narrow ? 300 : 400,
		routes: {} as Record<string, Route>,
		reqs: [] as Req[],
	};
	for (const to of ['cf', 'nw'] as const) for (let i = 0; i < 6; i++) L.routes[to + i] = routeOf(L, to, i);
	if (!mini) L.reqs = requests(L);
	return L;
}

type Grid = { origin: Record<'cf' | 'nw', Pt>; T: number; G: number; cols: number };
type Geometry = Grid & { CX: number; JY: number; R: number; users: Box; cf: Box; nw: Box; head: number; hold: number };
const slot = (L: Grid, to: 'cf' | 'nw', i: number) => {
	const o = L.origin[to];
	return { x: o.x + (i % L.cols) * (L.T + L.G), y: o.y + Math.floor(i / L.cols) * (L.T + L.G) };
};
const center = (L: Grid, to: 'cf' | 'nw', i: number) => {
	const s = slot(L, to, i);
	return { x: s.x + L.T / 2, y: s.y + L.T / 2 };
};

// A request's way: down from Users through DNS to the switch, along the branch,
// a stop in front of the box (where it waits for a copy), then into its object.
function routeOf(L: Geometry, to: 'cf' | 'nw', i: number): Route {
	const b = L[to], x = b.x + b.w / 2, dir = Math.sign(x - L.CX), R = L.R;
	const pts: Pt[] = [{ x: L.CX, y: L.users.y + L.users.h }, { x: L.CX, y: L.JY }, { x: x - dir * R, y: L.JY }];
	for (let s = 1; s <= 8; s++) {
		const u = s / 8;
		pts.push({ x: (1 - u) * (1 - u) * (x - dir * R) + 2 * (1 - u) * u * x + u * u * x, y: (1 - u) * (1 - u) * L.JY + 2 * (1 - u) * u * L.JY + u * u * (L.JY + R) });
	}
	pts.push({ x, y: b.y - L.hold });
	const holdAt = pts.length - 1;
	pts.push({ x, y: b.y + L.head / 2 }, center(L, to, i));
	const cum = [0];
	for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
	return { pts, cum, len: cum[cum.length - 1], hold: cum[holdAt] };
}
const pointAt = (r: Route, d: number): Pt => {
	let k = 1;
	while (k < r.pts.length - 1 && r.cum[k] < d) k++;
	const a = r.pts[k - 1], b = r.pts[k], seg = r.cum[k] - r.cum[k - 1] || 1;
	const u = clamp((d - r.cum[k - 1]) / seg);
	return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) };
};
const branchPath = (L: Geometry, b: Box) => {
	const x = b.x + b.w / 2, dir = Math.sign(x - L.CX);
	return `M${r2(L.CX)} ${r2(L.JY)} H${r2(x - dir * L.R)} Q${r2(x)} ${r2(L.JY)} ${r2(x)} ${r2(L.JY + L.R)} V${r2(b.y)}`;
};
// The branch's length, a little long so its dash always covers it.
const branchLen = (L: Geometry, b: Box) => {
	const x = b.x + b.w / 2;
	return Math.abs(x - L.CX) - L.R + L.R * 1.62 + (b.y - L.JY - L.R) + 2;
};

// Requests through the loop, as on the landing page.
function requests(L: { JY: number; users: Box; speed: number }): Req[] {
	const reqs: Req[] = [];
	let seed = 7;
	const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
	const toJ = (L.JY - L.users.y - L.users.h) / L.speed;
	for (let t = -1.4; t < FLIP - toJ - 0.1; t += 0.42) reqs.push({ t, i: Math.floor(rnd() * 6), to: 'cf' });
	// The first request after cutover is for A: it waits at OpenOrange while A copies.
	for (const m of MOVES.slice(0, 3)) reqs.push({ t: m.i === 0 ? FLIP + 0.35 : m.t - 0.9, i: m.i, to: 'nw', hold: m.t + MOVE });
	for (let t = LZ + 1.4; t < END - 0.6; t += 0.42) {
		const done = [0, 1, 2, 3, 4, 5].filter((i) => mv(i).t + MOVE < t + 0.6);
		if (done.length) reqs.push({ t, i: done[Math.floor(rnd() * done.length)], to: 'nw' });
	}
	return reqs;
}

/** Everything that changes in the scene, at one moment. */
export type Frame = {
	// The DNS record's target and its edit.
	value: string; saved: boolean; ring: number; sel: number; caret: boolean; pulse: number; ttlSaved: boolean;
	// The live route: 0 to Cloudflare, 1 to OpenOrange. The switch arm's angle.
	f: number; arm: number;
	cfFade: number; nwGlow: number;
	tiles: { x: number; y: number; sc: number; lit: number; flying: boolean }[];
	ghosts: boolean[];
	lands: { i: number; k: number }[];
	backfill: number; spin: number;
	dots: { x: number; y: number; i: number; waiting: boolean }[];
	ripples: { x: number; y: number; k: number }[];
	// The step diagrams only.
	nwState: 'on' | 'absent'; cfState: 'on' | 'removed'; badge: 'none' | 'local' | 'deployed'; d1: 'cf' | 'moved'; forward: boolean;
};

/** The animation at `t` seconds. */
export function sceneFrame(t: number, L: Layout): Frame {
	const editing = t >= FOCUS && t < FLIP + 0.35;
	const saved = t >= FLIP;
	let value = OLD;
	if (t >= CLEAR) value = NEW.slice(0, Math.max(0, Math.min(NEW.length, Math.floor((t - TYPE) / KEY) + 1)));
	const sel = t >= SELECT && t < CLEAR ? out((t - SELECT) / 0.3) : 0;
	const f = inOut((t - FLIP) / MED);
	const tiles: Frame['tiles'] = [], ghosts: boolean[] = [], lands: Frame['lands'] = [];
	for (let i = 0; i < 6; i++) {
		const m = mv(i), a0 = slot(L, 'cf', i), b0 = slot(L, 'nw', i);
		const raw = (t - m.t) / MOVE, k = inOut(raw);
		let x = lerp(a0.x, b0.x, k), y = lerp(a0.y, b0.y, k) - Math.sin(k * Math.PI) * (L.narrow ? 22 : 26);
		let sc = 1 + Math.sin(k * Math.PI) * 0.06;
		// Backfilled objects pass through the job.
		if (m.bf) {
			const mid = { x: L.bf.x - L.T / 2, y: L.bf.y - L.T / 2 };
			if (k < 0.5) { const kk = inOut(k * 2); x = lerp(a0.x, mid.x, kk); y = lerp(a0.y, mid.y, kk); sc = lerp(1, 0.45, kk); }
			else { const kk = inOut((k - 0.5) * 2); x = lerp(mid.x, b0.x, kk); y = lerp(mid.y, b0.y, kk); sc = lerp(0.45, 1, kk); }
		}
		tiles.push({ x, y, sc, lit: clamp((k - 0.3) / 0.4), flying: raw > 0 && raw < 1 });
		ghosts.push(raw > 0);
		const land = (t - (m.t + MOVE)) / MED;
		if (land > 0 && land < 1) lands.push({ i, k: land });
	}
	// Requests. They pass behind the DNS record (the lookup) and a box's header (its front door).
	const dots: Frame['dots'] = [], ripples: Frame['ripples'] = [];
	for (const q of L.reqs) {
		const r = L.routes[q.to + q.i];
		let d = (t - q.t) * L.speed, waiting = false;
		if (d < 0) continue;
		if (q.hold) {
			const arrive = q.t + r.hold / L.speed;
			if (t >= arrive) {
				if (t < q.hold) { d = r.hold; waiting = true; }
				else d = r.hold + (t - q.hold) * L.speed;
			}
		}
		if (d >= r.len) {
			const k = (d - r.len) / 260;
			if (k <= 1) ripples.push({ ...center(L, q.to, q.i), k });
			continue;
		}
		const p = pointAt(r, d);
		if (p.y > L.dns.y - 2 && p.y < L.dns.y + L.dns.h + 2) continue;
		if (p.y > L.cf.y - L.dot && p.y < L.cf.y + L.head + L.dot) continue;
		dots.push({ ...p, i: q.i, waiting });
	}
	return {
		value, saved, sel, ttlSaved: saved && t < FLIP + 1.8,
		ring: editing ? out((t - FOCUS) / 0.2) : 0,
		caret: editing && !saved && sel === 0 && (t >= CLEAR || Math.floor((t - FOCUS) * 2.5) % 2 === 0),
		pulse: (t - FLIP) / 0.7,
		f, arm: Math.PI * (1 - inOut((t - FLIP) / 0.45)),
		cfFade: 0.55 * out((t - (AFTER + 0.3)) / MED),
		nwGlow: 0.55 * f * (1 - out((t - AFTER) / MED)),
		tiles, ghosts, lands,
		backfill: out((t - BF) / FAST) * (1 - out((t - AFTER) / FAST)),
		spin: t, dots, ripples,
		nwState: 'on', cfState: 'on', badge: 'none', d1: 'cf', forward: false,
	};
}

// The state after each step of the guide's quickstart, in order.
export const STEP_STATES = ['before', 'prepared', 'deployed', 'orange', 'd1', 'dns', 'backfill', 'cleanup'] as const;
export type StepState = (typeof STEP_STATES)[number];
export const STEP_LABELS: Record<StepState, string> = {
	before: 'Every request goes to Cloudflare.',
	prepared: 'The prepared Worker is on your machine only.',
	deployed: 'The prepared Worker serves on Cloudflare.',
	orange: 'OpenOrange runs alongside, with no traffic.',
	d1: 'D1 runs on OpenOrange. Cloudflare forwards its queries.',
	dns: 'Requests go to OpenOrange. An object copies on its first request.',
	backfill: 'The backfill copies the objects that got no request.',
	cleanup: 'OpenOrange serves everything. Cloudflare is gone.',
};

/** The still for a step diagram. */
export function stepFrame(state: StepState, L: Layout): Frame {
	const at = STEP_STATES.indexOf(state);
	const past = (s: StepState) => at >= STEP_STATES.indexOf(s);
	const switched = past('dns');
	// After the cutover, A, C and E got a request; the backfill moves the rest.
	const moved = (i: number) => past('backfill') || (switched && i % 2 === 0);
	const removed = state === 'cleanup';
	const hold = L.routes.nw1.pts[L.routes.nw1.pts.length - 3];
	return {
		value: switched ? NEW : OLD, saved: switched, ring: 0, sel: 0, caret: false, pulse: -1, ttlSaved: false,
		f: switched ? 1 : 0, arm: switched ? 0 : Math.PI,
		cfFade: 0, nwGlow: switched && !removed ? 0.55 : 0,
		tiles: [0, 1, 2, 3, 4, 5].map((i) => ({ ...slot(L, moved(i) ? 'nw' : 'cf', i), sc: 1, lit: moved(i) ? 1 : 0, flying: false })),
		ghosts: [0, 1, 2, 3, 4, 5].map((i) => moved(i) && !removed),
		lands: [],
		backfill: state === 'backfill' ? 1 : 0, spin: 0.15,
		// A request for B waits at OpenOrange while B copies.
		dots: state === 'dns' ? [{ ...hold, i: 1, waiting: true }] : [],
		ripples: [],
		nwState: past('orange') ? 'on' : 'absent',
		cfState: removed ? 'removed' : 'on',
		badge: state === 'prepared' ? 'local' : past('deployed') && !removed ? 'deployed' : 'none',
		d1: past('d1') ? 'moved' : 'cf',
		forward: state === 'd1',
	};
}

const ORANGE = '#F26B1D';
const INK = 'var(--color-ink)', SOFT = 'var(--color-ink-soft)', FAINT = 'var(--color-ink-faint)';
const LINE = 'var(--color-line)', WIRE = 'var(--mig-wire)', ROUTE = 'var(--mig-route)';
const SURFACE = 'var(--color-surface)', PAPER = 'var(--color-paper)', MID = 'var(--color-paper-mid)';
const OSOFT = 'var(--color-orange-soft)', ODEEP = 'var(--color-orange-deep)';
const LETTERS = 'ABCDEF';

type Attrs = Record<string, string | number | undefined>;
const r2 = (v: number) => Math.round(v * 100) / 100;
const attrs = (a: Attrs) =>
	Object.entries(a)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => ` ${k}="${typeof v === 'number' ? r2(v) : v}"`)
		.join('');
const tag = (name: string, a: Attrs, body?: string) => (body === undefined ? `<${name}${attrs(a)}/>` : `<${name}${attrs(a)}>${body}</${name}>`);
const text = (s: string, a: Attrs) => tag('text', a, s.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
const rect = (b: Box, a: Attrs) => tag('rect', { x: b.x, y: b.y, width: b.w, height: b.h, ...a });
const icon = (name: string, x: number, y: number, size: number, stroke?: string) => {
	const [vb, body, fill] = ICONS[name];
	const paint: Attrs = stroke ? { fill: 'none', stroke, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } : { fill: fill ?? undefined };
	return tag('svg', { x, y, width: size, height: size, viewBox: vb, ...paint }, body);
};
const logo = (x: number, y: number, size: number) => tag('image', { href: '/images/logo.png', x, y, width: size, height: size });
const trunkPath = (L: Layout) => `M${r2(L.CX)} ${r2(L.users.y + L.users.h)} V${r2(L.JY)}`;

// Drawn once: the idle wires, Users, the DNS record and the boxes. `fr` gives
// the parts that a step diagram changes: which boxes are there, the badge and D1.
function base(L: Layout, fr: Frame): [back: string, mid: string] {
	const { users, dns, cf, nw, field } = L;
	const mini = L.mini;
	// Wires: the idle ones dashed; the live route goes over them.
	let back = tag('path', { d: trunkPath(L), stroke: WIRE, 'stroke-width': 1.5, fill: 'none' });
	for (const b of [cf, nw]) back += tag('path', { d: branchPath(L, b), stroke: WIRE, 'stroke-width': 1.5, 'stroke-dasharray': '3 5', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });

	// The switch's pivot.
	let mid = tag('circle', { cx: L.CX, cy: L.JY, r: mini ? 3 : 4, fill: SURFACE, stroke: ROUTE, 'stroke-width': 1.5 });

	// Users.
	const uf = mini ? 11 : 13, ui = mini ? 11 : 14;
	mid += rect(users, { rx: users.h / 2, fill: SURFACE, stroke: LINE });
	mid += icon('users', users.x + (mini ? 10 : 15), users.y + (users.h - ui) / 2, ui, SOFT);
	mid += text('Users', { x: users.x + (mini ? 25 : 34), y: users.y + users.h / 2 + uf * 0.36, 'font-size': uf, 'font-weight': 500, fill: INK });

	// The DNS record.
	mid += rect(dns, { rx: mini ? 7 : 10, fill: SURFACE, stroke: LINE });
	if (mini) mid += icon('globe', dns.x + 8, dns.y + (dns.h - 11) / 2, 11, FAINT);
	else {
		mid += icon('globe', dns.x + 14, dns.y + 9, 12, FAINT);
		mid += text('DNS record', { x: dns.x + 32, y: dns.y + 19, 'font-size': 10.5, 'font-weight': 600, fill: FAINT, class: 'caps' });
		mid += tag('line', { x1: dns.x, x2: dns.x + dns.w, y1: dns.y + 28.5, y2: dns.y + 28.5, stroke: LINE });
	}
	const rowY = field.y + field.h / 2 + L.fs * 0.36;
	mid += text('app.example.com', { x: L.nameX, y: rowY, 'font-size': L.fs, fill: INK, class: 'mono' });
	if (L.typeX !== null) mid += text('CNAME', { x: L.typeX, y: rowY, 'font-size': L.fs, fill: FAINT, class: 'mono' });

	// Cloudflare and OpenOrange.
	const nf = mini ? 11 : L.narrow ? 12 : 13, is = mini ? 12 : L.narrow ? 15 : 17;
	const box = (b: Box, which: 'cf' | 'nw', there: boolean, gone: string) => {
		let s = rect(b, there ? { rx: mini ? 8 : 12, fill: SURFACE, stroke: LINE } : { rx: mini ? 8 : 12, fill: 'none', stroke: WIRE, 'stroke-dasharray': '4 4' });
		const ix = b.x + (mini ? 8 : L.narrow ? 11 : 14), iy = b.y + (L.head - is) / 2 - (mini ? 0 : 0.5);
		let headG = which === 'cf' ? icon('cf', ix, iy, is) : logo(ix, iy - 0.5, is + 1);
		headG += text(which === 'cf' ? 'Cloudflare' : 'OpenOrange', { x: ix + is + (mini ? 5 : 7), y: b.y + L.head / 2 + nf * 0.36, 'font-size': nf, 'font-weight': 600, fill: there ? INK : FAINT });
		s += there ? headG : tag('g', { opacity: 0.55 }, headG);
		if (!there) {
			s += text(gone, { x: b.x + b.w / 2, y: b.y + L.head + (b.h - L.head) / 2, 'font-size': mini ? 10 : 12, fill: FAINT, 'text-anchor': 'middle' });
			return s;
		}
		s += tag('line', { x1: b.x, x2: b.x + b.w, y1: b.y + L.head - 0.5, y2: b.y + L.head - 0.5, stroke: LINE });
		for (let i = 0; i < 6; i++) {
			const p = slot(L, which, i);
			s += tag('rect', { x: p.x + 0.5, y: p.y + 0.5, width: L.T - 1, height: L.T - 1, rx: L.rx, fill: 'none', stroke: WIRE, 'stroke-dasharray': mini ? '2 3' : '3 4' });
		}
		// Where OpenOrange runs, on the wide drawing.
		if (which === 'nw' && L.kind === 'wide')
			['aws', 'gcp', 'azure', 'rivet'].forEach((n, i) => (s += icon(n, b.x + b.w - 14 - 14 * 4 - 8 * 3 + i * 22, b.y + (L.head - 14) / 2, 14)));
		return s;
	};
	mid += box(cf, 'cf', fr.cfState === 'on', 'removed');
	mid += box(nw, 'nw', fr.nwState === 'on', 'not deployed');

	// The prepared Worker, as a badge on Cloudflare: dashed while it is only on your machine.
	if (fr.badge !== 'none') {
		const w = 42, bx = cf.x + cf.w - 5 - w, h = 13, y = cf.y + (L.head - h) / 2;
		const local = fr.badge === 'local';
		mid += tag('rect', { x: bx, y, width: w, height: h, rx: h / 2, fill: local ? 'none' : MID, stroke: local ? FAINT : LINE, 'stroke-dasharray': local ? '2 2' : undefined });
		mid += text('prepared', { x: bx + w / 2, y: y + 9.1, 'font-size': 8, 'font-weight': 500, fill: local ? FAINT : SOFT, 'text-anchor': 'middle' });
	}

	// Each side's D1 database: on Cloudflare until it moves, then an old copy there.
	if (L.d1) {
		const { w, h } = L.d1;
		const chip = (p: Pt, kind: 'data' | 'empty' | 'old' | 'moved') => {
			const moved = kind === 'moved', data = kind === 'data';
			const frame = moved ? { fill: ORANGE } : data ? { fill: MID, stroke: WIRE } : { fill: 'none', stroke: kind === 'old' ? FAINT : WIRE, 'stroke-opacity': kind === 'old' ? 0.5 : 1, 'stroke-dasharray': '2 3' };
			const ink = moved ? '#fff' : data ? SOFT : FAINT;
			let s = rect({ x: p.x + 0.5, y: p.y + 0.5, w: w - 1, h: h - 1 }, { rx: L.rx, ...frame });
			const g = icon('database', p.x + (w - 13) / 2, p.y + 5, 13, ink) + text('D1', { x: p.x + w / 2, y: p.y + h - 6, 'font-size': 8.5, 'font-weight': 600, fill: ink, 'text-anchor': 'middle', class: 'mono' });
			s += kind === 'old' || kind === 'empty' ? tag('g', { opacity: 0.6 }, g) : g;
			return s;
		};
		if (fr.cfState === 'on') mid += chip(L.d1.at.cf, fr.d1 === 'moved' ? 'old' : 'data');
		if (fr.nwState === 'on') mid += chip(L.d1.at.nw, fr.d1 === 'moved' ? 'moved' : 'empty');
		// After the D1 move, Cloudflare sends the database's queries to OpenOrange.
		if (fr.forward) {
			const y = L.d1.at.cf.y + h / 2, x1 = L.d1.at.cf.x + w + 3, x2 = L.d1.at.nw.x - 4;
			mid += tag('path', { d: `M${r2(x1)} ${r2(y)} H${r2(x2 - 3)}`, stroke: ORANGE, 'stroke-width': 1.5, 'stroke-dasharray': '2 3', fill: 'none' });
			mid += tag('path', { d: `M${r2(x2 - 5)} ${r2(y - 3.5)} L${r2(x2)} ${r2(y)} L${r2(x2 - 5)} ${r2(y + 3.5)}`, stroke: ORANGE, 'stroke-width': 1.5, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
		}
	}
	return [back, mid];
}

/** What changes from frame to frame: under the boxes, and over them. */
export function live(L: Layout, fr: Frame): [under: string, over: string] {
	const { cf, nw, field, dns, T } = L;
	// The live route: gray to Cloudflare until the switch, then orange to OpenOrange.
	let under = '';
	const trunk = trunkPath(L);
	if (fr.f < 1) under += tag('path', { d: trunk, stroke: ROUTE, 'stroke-width': 2, fill: 'none', opacity: 1 - fr.f });
	if (fr.f > 0) under += tag('path', { d: trunk, stroke: ORANGE, 'stroke-width': 2, fill: 'none', opacity: fr.f });
	const dc = branchLen(L, cf), dn = branchLen(L, nw);
	if (fr.f < 1) under += tag('path', { d: branchPath(L, cf), stroke: ROUTE, 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': `${r2(dc)} ${r2(dc)}`, 'stroke-dashoffset': -dc * fr.f });
	if (fr.f > 0) under += tag('path', { d: branchPath(L, nw), stroke: ORANGE, 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': `${r2(dn)} ${r2(dn)}`, 'stroke-dashoffset': dn * (1 - fr.f) });
	// The switch under DNS: an arm on the pivot, pointing down the live branch.
	under += tag('line', { x1: L.CX, y1: L.JY, x2: L.CX + L.arm * Math.cos(fr.arm), y2: L.JY + L.arm * Math.sin(fr.arm), stroke: fr.arm < Math.PI / 2 ? ORANGE : ROUTE, 'stroke-width': L.mini ? 2.5 : 3, 'stroke-linecap': 'round' });

	// The DNS record's target: saving it throws the switch.
	let over = '';
	if (fr.pulse > 0 && fr.pulse < 1) {
		const g = 3 + out(fr.pulse) * (L.pulse - 3);
		over += rect({ x: field.x - g, y: field.y - g, w: field.w + 2 * g, h: field.h + 2 * g }, { rx: 8, fill: 'none', stroke: ORANGE, 'stroke-width': 1.5, opacity: 1 - fr.pulse });
	}
	over += rect(field, { rx: L.mini ? 4 : 5, fill: fr.saved ? OSOFT : MID, stroke: fr.saved ? 'none' : LINE, 'stroke-width': 1 });
	if (fr.ring > 0) over += rect({ x: field.x - 2, y: field.y - 2, w: field.w + 4, h: field.h + 4 }, { rx: 7, fill: 'none', stroke: ORANGE, 'stroke-width': 1.5, opacity: fr.ring });
	const gs = L.mini ? 11 : 14, gx = field.x + (L.mini ? 5 : 7), gy = field.y + (field.h - gs) / 2;
	over += fr.saved ? logo(gx, gy - 0.5, gs + 1) : icon('cf', gx, gy, gs);
	const tx = gx + gs + (L.mini ? 5 : 7), rowY = field.y + field.h / 2 + L.fs * 0.36;
	if (fr.sel > 0) over += rect({ x: tx - 1, y: field.y + 4, w: OLD.length * L.cw * fr.sel + 2, h: field.h - 8 }, { rx: 2, fill: ORANGE, 'fill-opacity': 0.25 });
	over += text(fr.value, { x: tx, y: rowY, 'font-size': L.fs, fill: fr.saved ? ODEEP : INK, 'font-weight': fr.saved ? 600 : 400, class: 'mono' });
	if (fr.caret) over += rect({ x: tx + fr.value.length * L.cw + 0.5, y: field.y + 4, w: 1.5, h: field.h - 8 }, { fill: INK });
	if (!L.mini) over += text(fr.ttlSaved ? 'saved' : 'TTL 60', { x: dns.x + dns.w - 14, y: dns.y + 19, 'font-size': 10.5, fill: fr.ttlSaved ? ODEEP : FAINT, 'text-anchor': 'end', class: 'mono' });

	// What Cloudflare still holds once an object is copied: an old copy.
	for (let i = 0; i < 6; i++) {
		if (!fr.ghosts[i]) continue;
		const p = slot(L, 'cf', i);
		over += tag('rect', { x: p.x + 0.5, y: p.y + 0.5, width: T - 1, height: T - 1, rx: L.rx, fill: 'none', stroke: FAINT, 'stroke-opacity': 0.5, 'stroke-dasharray': L.mini ? '2 3' : '3 4' });
		over += text(LETTERS[i], { x: p.x + T / 2, y: p.y + T / 2 + L.tileFs * 0.35, 'font-size': L.tileFs, 'font-weight': 500, 'text-anchor': 'middle', fill: FAINT, 'fill-opacity': 0.6, class: 'mono' });
	}
	// Cloudflare fades once every request runs on OpenOrange.
	if (fr.cfFade > 0) over += rect({ x: cf.x - 1, y: cf.y - 1, w: cf.w + 2, h: cf.h + 2 }, { fill: PAPER, opacity: fr.cfFade });
	if (fr.nwGlow > 0) over += rect({ x: nw.x - 0.5, y: nw.y - 0.5, w: nw.w + 1, h: nw.h + 1 }, { rx: L.mini ? 8.5 : 12.5, fill: 'none', stroke: ORANGE, 'stroke-width': 1.5, opacity: fr.nwGlow });

	// The backfill job, between the two, wired to both.
	if (fr.backfill > 0) {
		const { bf } = L;
		let g = tag('path', { d: `M${r2(cf.x + cf.w)} ${r2(bf.y)} H${r2(bf.x - bf.r)} M${r2(bf.x + bf.r)} ${r2(bf.y)} H${r2(nw.x)}`, stroke: ORANGE, 'stroke-width': 1.5, 'stroke-dasharray': '2 4', 'stroke-dashoffset': -fr.spin * 18, fill: 'none' });
		g += tag('circle', { cx: bf.x, cy: bf.y, r: bf.r, fill: 'var(--color-plate)' });
		g += tag('g', { transform: `rotate(${r2(fr.spin * 240)} ${r2(bf.x)} ${r2(bf.y)})` }, icon('refresh', bf.x - bf.r * 0.5, bf.y - bf.r * 0.5, bf.r, '#f5f5f4'));
		if (bf.labelY !== null) g += text('backfill', { x: bf.x, y: bf.labelY, 'font-size': 11, 'text-anchor': 'middle', fill: FAINT, class: 'mono' });
		over += tag('g', { opacity: fr.backfill }, g);
	}
	for (const { i, k } of fr.lands) {
		const c = center(L, 'nw', i), r = T / 2 + 2 + out(k) * 10;
		over += rect({ x: c.x - r, y: c.y - r, w: 2 * r, h: 2 * r }, { rx: 10, fill: 'none', stroke: ORANGE, 'stroke-width': 1.5, opacity: 1 - k });
	}

	// The objects; one in flight draws over the rest.
	const order = [0, 1, 2, 3, 4, 5].sort((a, b) => Number(fr.tiles[a].flying) - Number(fr.tiles[b].flying));
	for (const i of order) {
		const tl = fr.tiles[i];
		if (fr.cfState === 'removed' && tl.lit === 0) continue;
		if (fr.nwState === 'absent' && tl.lit > 0) continue;
		let body = tag('rect', { width: T, height: T, rx: L.rx, fill: MID, stroke: WIRE, 'stroke-opacity': 1 - tl.lit });
		if (tl.lit > 0) body += tag('rect', { width: T, height: T, rx: L.rx, fill: ORANGE, opacity: tl.lit });
		body += text(LETTERS[i], { x: T / 2, y: T / 2 + L.tileFs * 0.35, 'font-size': L.tileFs, 'font-weight': 600, 'text-anchor': 'middle', fill: tl.lit > 0.5 ? '#fff' : SOFT, class: 'mono' });
		const transform = tl.sc === 1 ? `translate(${r2(tl.x)} ${r2(tl.y)})` : `translate(${r2(tl.x + T / 2)} ${r2(tl.y + T / 2)}) scale(${r2(tl.sc)}) translate(${r2(-T / 2)} ${r2(-T / 2)})`;
		over += tag('g', { transform }, body);
	}

	// Requests, and the ripple where each one lands. One that waits for its
	// object draws over the ones passing it.
	for (const p of fr.ripples) {
		const rr = T / 2 + 1 + p.k * 8;
		over += rect({ x: p.x - rr, y: p.y - rr, w: 2 * rr, h: 2 * rr }, { rx: 10, fill: 'none', stroke: INK, 'stroke-width': 1.25, opacity: 0.4 * (1 - p.k) });
	}
	const dot = L.dot;
	for (const p of [...fr.dots.filter((d) => !d.waiting), ...fr.dots.filter((d) => d.waiting)]) {
		over += tag('circle', { cx: p.x, cy: p.y, r: dot, fill: INK });
		over += text(LETTERS[p.i], { x: p.x, y: p.y + dot * 0.48, 'font-size': dot * 1.35, 'font-weight': 700, 'text-anchor': 'middle', fill: PAPER, class: 'mono' });
		if (p.waiting) over += tag('circle', { cx: p.x, cy: p.y, r: dot + (L.mini ? 3.5 : 4.5), fill: 'none', stroke: ORANGE, 'stroke-width': L.mini ? 1.75 : 2, 'stroke-linecap': 'round', 'stroke-dasharray': `${r2(dot * 2.2)} 100`, transform: `rotate(${r2(fr.spin * 420)} ${r2(p.x)} ${r2(p.y)})` });
	}
	return [under, over];
}

/** The whole scene as an <svg>, with the changing parts in `data-under` and `data-over`. */
export function renderSvg(L: Layout, fr: Frame, a: Attrs): string {
	const [back, mid] = base(L, fr);
	const [under, over] = live(L, fr);
	return tag('svg', { viewBox: `0 0 ${L.W} ${r2(L.H)}`, ...a }, `${back}<g data-under>${under}</g>${mid}<g data-over>${over}</g>`);
}
