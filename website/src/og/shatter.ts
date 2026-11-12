// The break-glass box frozen just after the hammer hits it, for the Open Graph
// cards. A port of the shatter in src/components/BreakGlass.astro: the same
// spider-web fracture, shard physics, lighting and hammer swing, stepped to one
// moment with a fixed seed and drawn as SVG instead of on a canvas. Keep the
// two in step when the animation changes.
//
// Coordinates are the box photo's (760×1013); the SVG extends past it by VIEW
// so shards and the hammer can leave the box.

type V2 = [number, number];
type V3 = [number, number, number];

const W = 760;
const H = 1013;
const PANE = { x0: 100, y0: 132, x1: 560, y1: 827 };
const LEDGE = PANE.y1 + 4;
const G = 3000;
const FOCAL = 1100;
const THICK = 5;

/** The SVG's box, in photo coordinates. */
export const VIEW = { x: -90, y: -70, w: 1000, h: 1200 };

/** Where the hammer hits (the hero's keyboard default), and how long after. */
export const IMPACT: V2 = [300, 380];
export const MOMENT = 0.28;
const SEED = 7;

type Shard = {
	poly: V2[];
	tri: [number, number, number];
	c: V2;
	pos: V3;
	vel: V3;
	rot: V3;
	spin: V3;
	detachAt: number;
	crackAt: number;
	state: 'fixed' | 'flying' | 'gone';
	bounced: boolean;
};

// mulberry32: the animation uses Math.random(); a seed makes every build the same.
function seeded(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function clipToPane(poly: V2[]): V2[] {
	const edges: [(p: V2) => boolean, (a: V2, b: V2) => V2][] = [
		[(p) => p[0] >= PANE.x0, (a, b) => [PANE.x0, a[1] + ((b[1] - a[1]) * (PANE.x0 - a[0])) / (b[0] - a[0])]],
		[(p) => p[0] <= PANE.x1, (a, b) => [PANE.x1, a[1] + ((b[1] - a[1]) * (PANE.x1 - a[0])) / (b[0] - a[0])]],
		[(p) => p[1] >= PANE.y0, (a, b) => [a[0] + ((b[0] - a[0]) * (PANE.y0 - a[1])) / (b[1] - a[1]), PANE.y0]],
		[(p) => p[1] <= PANE.y1, (a, b) => [a[0] + ((b[0] - a[0]) * (PANE.y1 - a[1])) / (b[1] - a[1]), PANE.y1]],
	];
	let out = poly;
	for (const [inside, cut] of edges) {
		const input = out;
		out = [];
		for (let i = 0; i < input.length; i++) {
			const a = input[i];
			const b = input[(i + 1) % input.length];
			if (inside(b)) {
				if (!inside(a)) out.push(cut(a, b));
				out.push(b);
			} else if (inside(a)) {
				out.push(cut(a, b));
			}
		}
		if (!out.length) break;
	}
	return out;
}

const onFrame = ([x, y]: V2) => x <= PANE.x0 + 0.5 || x >= PANE.x1 - 0.5 || y <= PANE.y0 + 0.5 || y >= PANE.y1 - 0.5;
function jagged(poly: V2[]): V2[] {
	const out: V2[] = [];
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		out.push(a);
		if (onFrame(a) && onFrame(b) && (Math.abs(a[0] - b[0]) < 1 || Math.abs(a[1] - b[1]) < 1)) continue;
		const key = (p: V2) => Math.round(p[0] * 10) * 100003 + Math.round(p[1] * 10);
		const flip = key(a) > key(b);
		const [p, q] = flip ? [b, a] : [a, b];
		const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
		if (len < 18) continue;
		let h = (key(p) * 31 + key(q)) % 2147483647;
		const next = () => ((h = (h * 48271) % 2147483647) / 2147483647) * 2 - 1;
		const nx = -(q[1] - p[1]) / len;
		const ny = (q[0] - p[0]) / len;
		const mids = [1 / 3, 2 / 3].map((f) => {
			const o = next() * len * 0.07;
			return [p[0] + (q[0] - p[0]) * f + nx * o, p[1] + (q[1] - p[1]) * f + ny * o] as V2;
		});
		out.push(...(flip ? mids.reverse() : mids));
	}
	return out;
}

function bigTriangle(poly: V2[]): [number, number, number] {
	let best: [number, number, number] = [0, 1, 2];
	let most = -1;
	for (let i = 0; i < poly.length; i++)
		for (let j = i + 1; j < poly.length; j++)
			for (let k = j + 1; k < poly.length; k++) {
				const a2 = Math.abs((poly[j][0] - poly[i][0]) * (poly[k][1] - poly[i][1]) - (poly[k][0] - poly[i][0]) * (poly[j][1] - poly[i][1]));
				if (a2 > most) {
					most = a2;
					best = [i, j, k];
				}
			}
	return best;
}

const area = (poly: V2[]) => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const touchesFrame = (poly: V2[]) => poly.some(([x, y]) => x <= PANE.x0 + 0.5 || x >= PANE.x1 - 0.5 || y <= PANE.y0 + 0.5 || y >= PANE.y1 - 0.5);

function fracture(ix: number, iy: number, rand: (a: number, b: number) => number, random: () => number): Shard[] {
	const rays = 15;
	const angles = Array.from({ length: rays }, (_, i) => ((i + rand(-0.32, 0.32)) / rays) * Math.PI * 2).sort((a, b) => a - b);
	const radii = [14, 34, 62, 100, 150, 215, 300, 410, 560, 800];
	const pts = angles.map((a) =>
		radii.map((r, k) => {
			const rr = k === 0 ? r : r * rand(0.82, 1.18);
			const aa = a + (k ? rand(-0.06, 0.06) : 0);
			return [ix + Math.cos(aa) * rr, iy + Math.sin(aa) * rr] as V2;
		}),
	);
	const shards: Shard[] = [];
	const add = (cell: V2[], dist: number) => {
		const clipped = clipToPane(cell);
		if (clipped.length < 3 || area(clipped) < 6) return;
		const c: V2 = [clipped.reduce((s, p) => s + p[0], 0) / clipped.length, clipped.reduce((s, p) => s + p[1], 0) / clipped.length];
		const far = Math.max(...clipped.map(([x, y]) => Math.hypot(x - ix, y - iy)));
		const stuck = touchesFrame(clipped) && dist > 120 && random() < 0.5;
		const lateFall = stuck && random() < 0.5;
		const poly = jagged(clipped);
		shards.push({
			poly,
			tri: bigTriangle(poly),
			c,
			pos: [c[0], c[1], 0],
			vel: [0, 0, 0],
			rot: [0, 0, 0],
			spin: [0, 0, 0],
			detachAt: stuck ? (lateFall ? rand(0.55, 1.4) : Infinity) : 0.075 + dist / 3800 + rand(0, 0.05) + (dist > 250 ? rand(0, 0.18) : 0),
			crackAt: far / 4200,
			state: 'fixed',
			bounced: false,
		});
	};
	for (let i = 0; i < rays; i++) {
		const j = (i + 1) % rays;
		add([[ix, iy], pts[i][0], pts[j][0]], 0);
		for (let k = 0; k < radii.length - 1; k++) {
			const quad: V2[] = [pts[i][k], pts[i][k + 1], pts[j][k + 1], pts[j][k]];
			const dist = radii[k];
			if (k > 1 && random() < 0.45) {
				add([quad[0], quad[1], quad[2]], dist);
				add([quad[0], quad[2], quad[3]], dist);
			} else {
				add(quad, dist);
			}
		}
	}
	return shards;
}

function launch(s: Shard, ix: number, iy: number, rand: (a: number, b: number) => number) {
	const dx = s.c[0] - ix;
	const dy = s.c[1] - iy;
	const d = Math.max(1, Math.hypot(dx, dy));
	const kick = 950 * Math.exp(-d / 110);
	s.vel = [
		(dx / d) * kick * rand(0.6, 1.2) + rand(-25, 25),
		(dy / d) * kick * 0.8 - rand(0, 160) * Math.exp(-d / 160) + rand(-10, 30),
		620 * Math.exp(-d / 140) + rand(30, 140),
	];
	const tumble = 2 + 10 * Math.exp(-d / 180);
	s.spin = [rand(-1, 1) * tumble, rand(-1, 1) * tumble, rand(-1, 1) * (1 + tumble * 0.4)];
	s.state = 'flying';
}

function rotate([x, y, z]: V3, [ax, ay, az]: V3): V3 {
	const cz = Math.cos(az), sz = Math.sin(az);
	[x, y] = [x * cz - y * sz, x * sz + y * cz];
	const cx = Math.cos(ax), sx = Math.sin(ax);
	[y, z] = [y * cx - z * sx, y * sx + z * cx];
	const cy = Math.cos(ay), sy = Math.sin(ay);
	[x, z] = [x * cy + z * sy, -x * sy + z * cy];
	return [x, y, z];
}

function project([x, y, z]: V3): V2 {
	const k = FOCAL / Math.max(80, FOCAL - z);
	return [W / 2 + (x - W / 2) * k, H / 2 + (y - H / 2) * k];
}

const HALF: V3 = (() => {
	const l: V3 = [-0.45, -0.6, 0.66];
	const h: V3 = [l[0], l[1], l[2] + 1];
	const n = Math.hypot(...h);
	return [h[0] / n, h[1] / n, h[2] / n];
})();

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const n = (v: number) => Math.round(v * 100) / 100;
const pts = (poly: V2[]) => poly.map(([x, y]) => `${n(x)},${n(y)}`).join(' ');

/** SVG for one shard, as drawShard() in BreakGlass.astro paints it. */
function shardSvg(s: Shard, id: number, t: number): string {
	const local = s.poly.map(([x, y]) => [x - s.c[0], y - s.c[1], 0] as V3);
	const place = (p: V3) => { const r = rotate(p, s.rot); return project([r[0] + s.pos[0], r[1] + s.pos[1], r[2] + s.pos[2]]); };
	const front = local.map(place);
	const nrm = rotate([0, 0, 1], s.rot);
	const fresnel = 1 - Math.abs(nrm[2]);
	const spec = Math.pow(Math.max(0, nrm[0] * HALF[0] + nrm[1] * HALF[1] + nrm[2] * HALF[2]), 28);
	const moving = s.state !== 'fixed';
	let out = '';
	// Glass thickness: the sides, in the green of a glass edge.
	if (moving && fresnel > 0.05) {
		const back = local.map(([x, y]) => place([x, y, -THICK]));
		const fill = `fill="rgb(160,205,195)" fill-opacity="${n(0.12 + fresnel * 0.3)}"`;
		for (let i = 0; i < front.length; i++) {
			const j = (i + 1) % front.length;
			out += `<polygon points="${pts([front[i], front[j], back[j], back[i]])}" ${fill}/>`;
		}
	}
	const face = pts(front);
	out += `<clipPath id="s${id}"><polygon points="${face}"/></clipPath>`;
	out += `<polygon points="${face}" fill="rgb(205,225,235)" fill-opacity="${n(moving ? 0.06 + fresnel * 0.4 : 0.03)}"/>`;
	// The printed text and the reflection, mapped onto the shard (affine from three corners).
	const [i0, i1, i2] = s.tri;
	const [a, b, c] = [s.poly[i0], s.poly[i1], s.poly[i2]];
	const [A, B, C] = [front[i0], front[i1], front[i2]];
	const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
	if (Math.abs(det) > 1e-3) {
		const m11 = ((B[0] - A[0]) * (c[1] - a[1]) - (C[0] - A[0]) * (b[1] - a[1])) / det;
		const m12 = ((B[1] - A[1]) * (c[1] - a[1]) - (C[1] - A[1]) * (b[1] - a[1])) / det;
		const m21 = ((C[0] - A[0]) * (b[0] - a[0]) - (B[0] - A[0]) * (c[0] - a[0])) / det;
		const m22 = ((C[1] - A[1]) * (b[0] - a[0]) - (B[1] - A[1]) * (c[0] - a[0])) / det;
		const dx = A[0] - m11 * a[0] - m21 * a[1];
		const dy = A[1] - m12 * a[0] - m22 * a[1];
		out += `<g clip-path="url(#s${id})"><use href="#pane" transform="matrix(${[m11, m12, m21, m22, dx, dy].map((v) => n(v * 1000) / 1000).join(' ')})"/></g>`;
	}
	// A soft band of light across the face as it turns to the light.
	if (moving && spec > 0.02) {
		const xs = front.map((p) => p[0]);
		const ys = front.map((p) => p[1]);
		const peak = clamp(0.5 + 0.45 * Math.sin(s.rot[0] * 1.3 + s.rot[1]), 0.08, 0.92);
		const o = n(Math.min(0.55, spec * 0.7));
		out += `<linearGradient id="g${id}" gradientUnits="userSpaceOnUse" x1="${n(Math.min(...xs))}" y1="${n(Math.min(...ys))}" x2="${n(Math.max(...xs))}" y2="${n(Math.max(...ys))}"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="${n(Math.max(0, peak - 0.18))}" stop-color="#fff" stop-opacity="0"/><stop offset="${n(peak)}" stop-color="#fff" stop-opacity="${o}"/><stop offset="${n(Math.min(1, peak + 0.18))}" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`;
		out += `<polygon points="${face}" fill="url(#g${id})"/>`;
	}
	// Edges: a dark line for contrast and a bright one on top, once the crack front has passed.
	const edge = moving ? 1 : clamp((t - s.crackAt) / 0.05, 0, 1);
	if (edge > 0) {
		out += `<polygon points="${face}" fill="none" stroke="rgb(20,30,35)" stroke-opacity="${n(0.35 * edge)}" stroke-width="2.6" stroke-linejoin="round"/>`;
		out += `<polygon points="${face}" fill="none" stroke="#fff" stroke-opacity="${n((0.55 + fresnel * 0.4) * edge)}" stroke-width="1.1" stroke-linejoin="round"/>`;
	}
	return out;
}

/**
 * The hammer `t` seconds after the hit, as the hero swings it: the grip sits
 * below and right of the impact, the head lands on it at 0.08 s, holds until
 * 0.16 s, then lifts back to its cocked angle by 0.42 s.
 */
function hammerSvg(hammer: string, [ix, iy]: V2, t: number): string {
	const HD = H * 0.4;
	const HW = (HD * 209) / 560;
	const HL = HD * 0.86;
	const reach = HL * 0.7;
	const g: V2 = [ix + reach * 0.94, iy + reach * 0.34];
	const aim = Math.atan2(iy - g[1], ix - g[0]);
	// The click both breaks the glass and starts the swing, so they share a clock.
	const swing = t < 0.08 ? t / 0.08 : t < 0.16 ? 1 : t < 0.42 ? 1 - (t - 0.16) / 0.26 : 0;
	const cocked = aim + 1.15;
	const a = cocked + (aim - cocked) * swing;
	const dir: V2 = [Math.cos(a), Math.sin(a)];
	const e: V2 = [g[0] - dir[0] * HL * 0.3, g[1] - dir[1] * HL * 0.3];
	const head: V2 = [g[0] + dir[0] * HL * 0.7, g[1] + dir[1] * HL * 0.7];
	const angle = (Math.atan2(head[0] - e[0], -(head[1] - e[1])) * 180) / Math.PI;
	// The chain hangs from the frame's right edge, a third down, and sags to the handle.
	const anchor: V2 = [630, H * 0.3];
	const seg = H * 0.026;
	const ctrl: V2 = [Math.max(anchor[0], e[0]) + 70, (anchor[1] + e[1]) / 2 + 40];
	const bez = (u: number): V2 => [
		(1 - u) ** 2 * anchor[0] + 2 * (1 - u) * u * ctrl[0] + u ** 2 * e[0],
		(1 - u) ** 2 * anchor[1] + 2 * (1 - u) * u * ctrl[1] + u ** 2 * e[1],
	];
	const steps = 12;
	let links = '';
	for (let i = 0; i < steps; i++) {
		const p = bez(i / steps);
		const q = bez((i + 1) / steps);
		const m: V2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
		const rot = (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI;
		links += `<ellipse cx="0" cy="0" rx="${n(seg * 0.7)}" ry="${n(i % 2 ? seg * 0.1 : seg * 0.32)}" transform="translate(${n(m[0])} ${n(m[1])}) rotate(${n(rot)})" fill="none" stroke="url(#chain)" stroke-width="${n(Math.max(2, seg * 0.2))}"/>`;
	}
	return (
		`<linearGradient id="chain" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#e2e5e8"/><stop offset=".5" stop-color="#8b9198"/><stop offset="1" stop-color="#565c63"/></linearGradient>` +
		`<g filter="url(#soft)">${links}</g>` +
		`<g filter="url(#drop)" transform="translate(${n(e[0])} ${n(e[1])}) rotate(${n(angle)})"><image href="${hammer}" x="${n(-HW / 2)}" y="${n(-HD + 3)}" width="${n(HW)}" height="${n(HD)}"/></g>`
	);
}

/**
 * The broken box as one SVG: the open box, every shard still in view at
 * MOMENT seconds after the hit, glass dust, the flash, and the hammer.
 * Images are data URIs: `open` and `pane` are the 760×1013 photos.
 */
export function brokenBoxSvg(images: { open: string; pane: string; hammer: string }, t = MOMENT): string {
	const random = seeded(SEED);
	const rand = (a: number, b: number) => a + random() * (b - a);
	const [ix, iy] = IMPACT;
	const shards = fracture(ix, iy, rand, random);
	// Step the physics at 60 fps, as the browser does.
	const dt = 1 / 60;
	for (let time = dt; time <= t + 1e-9; time += dt) {
		for (const s of shards) {
			if (s.state === 'fixed' && time >= s.detachAt) launch(s, ix, iy, rand);
			if (s.state !== 'flying') continue;
			s.vel[1] += G * dt;
			s.vel[0] *= 0.995;
			for (let i = 0; i < 3; i++) {
				s.pos[i] += s.vel[i] * dt;
				s.rot[i] += s.spin[i] * dt;
			}
			if (!s.bounced && s.pos[2] < 40 && s.pos[1] > LEDGE - 6 && s.c[0] > PANE.x0 && s.c[0] < PANE.x1 && s.vel[1] > 0) {
				s.bounced = true;
				s.pos[1] = LEDGE - 6;
				s.vel[1] *= -0.28;
				s.vel[0] *= 0.6;
				s.vel[2] += rand(140, 260);
				s.spin = [s.spin[0] * 0.5 + rand(4, 8), s.spin[1] * 0.5, s.spin[2] * 0.5];
			}
			if (s.pos[1] > H + 900) s.state = 'gone';
		}
	}
	// Glass dust: 70 motes from the impact, each alive for under a second.
	const dust = Array.from({ length: 70 }, () => {
		const a = rand(0, Math.PI * 2);
		const v = rand(200, 1300);
		const life = rand(0.3, 0.8);
		const size = rand(1, 2.6);
		let [x, y, vx, vy] = [ix, iy, Math.cos(a) * v, Math.sin(a) * v - 200];
		for (let time = dt; time <= t + 1e-9; time += dt) {
			vy += G * 0.6 * dt;
			x += vx * dt;
			y += vy * dt;
			vx *= 0.96;
		}
		return t > life ? '' : `<rect x="${n(x)}" y="${n(y)}" width="${n(size * 1.6)}" height="${n(size * 1.6)}" fill="#fff" fill-opacity="${n(0.9 * (1 - t / life))}"/>`;
	}).join('');
	// The flash of the impact, fading over 0.22 s.
	const f = t / 0.22;
	const flash = f < 1
		? `<radialGradient id="flash" gradientUnits="userSpaceOnUse" cx="${ix}" cy="${iy}" r="${n(30 + 260 * Math.sqrt(f))}"><stop offset="0" stop-color="#fff" stop-opacity="${n(0.95 * (1 - f))}"/><stop offset=".25" stop-color="rgb(255,250,235)" stop-opacity="${n(0.45 * (1 - f))}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><circle cx="${ix}" cy="${iy}" r="${n(30 + 260 * Math.sqrt(f))}" fill="url(#flash)"/>`
		: '';
	// Shards still in the frame first, then the ones in flight, nearest last.
	const order = shards.filter((s) => s.state !== 'gone').sort((a, b) => (a.state === 'fixed' ? -1 : a.pos[2]) - (b.state === 'fixed' ? -1 : b.pos[2]));
	const glass = order.map((s, i) => shardSvg(s, i, t)).join('');
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${VIEW.w}" height="${VIEW.h}" viewBox="${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}">` +
		`<defs><image id="pane" href="${images.pane}" x="0" y="0" width="${W}" height="${H}"/>` +
		`<filter id="drop" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="6" dy="12" stdDeviation="8" flood-color="rgb(26,25,24)" flood-opacity="0.3"/></filter>` +
		`<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="2" dy="4" stdDeviation="2" flood-color="rgb(26,25,24)" flood-opacity="0.22"/></filter></defs>` +
		`<image href="${images.open}" x="0" y="0" width="${W}" height="${H}"/>` +
		glass +
		dust +
		flash +
		hammerSvg(images.hammer, IMPACT, t) +
		`</svg>`
	);
}
