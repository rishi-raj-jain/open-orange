// Copy for the comparison pages /vs-celld/, /vs-rivet/ and /vs-miniflare/,
// rendered by src/pages/vs-[competitor].astro. /vs-workerd/ has its own page
// and its data lives in site.ts.
//
// Every claim about another project is sourced, and the page lists its
// sources. celld claims come from celld v0.6.3 (8702f6d, 2026-10-21), its
// docs, issues and releases, and the October 2026 announcements, as read on
// 2026-11-12. Miniflare claims come from Cloudflare's Miniflare docs, read on
// 2026-11-12. Rivet claims come from rivet.dev. Re-check them before changing
// AS_OF.

import { MODULES, SITE } from './site';

export const AS_OF = { label: 'November 12, 2026', iso: '2026-11-12' } as const;

// The Cloudflare APIs documented in docs/modules/, not counting the runtime globals.
const CLOUDFLARE_APIS = MODULES.filter((m) => m.doc !== 'globals').length;

/** How a matrix cell reads at a glance. */
export type Mark = 'yes' | 'partial' | 'no';
export type Cell = { text: string; mark?: Mark; note?: string };
export type MatrixRow = { label: string; them: Cell; us: Cell } | { label: string; same: string };

export type Product = {
	name: string;
	body: string;
	/** A short status shown on the product's card. */
	badge?: { text: string; tone: 'good' | 'muted' };
};

export type Pick = {
	title: string;
	/** One sentence above the list. */
	lead?: string;
	items: string[];
	/** Rendered as the dark plate. */
	highlight?: boolean;
};

export type TimelineEvent = { date: string; iso: string; text: string; href?: string };
export type Stat = { value: string; label: string; body: string };
export type Link = { label: string; href: string };

export type Comparison = {
	slug: string;
	name: string;
	/** <title> and the meta description. */
	title: string;
	description: string;
	headline: string;
	lede: string;
	them: Product;
	us: Product;
	picks: Pick[];
	matrix: { title: string; rows: MatrixRow[]; caption?: string };
	timeline?: { title: string; lede: string; events: TimelineEvent[] };
	stats?: { title: string; lede: string; items: Stat[]; caption?: string };
	sources: Link[];
	cta: { title: string; body: string; primary?: Link; secondary?: Link };
};

// What Rivet's storage engine does, as Rivet states it. Shared by the pages
// that talk about storage.
const WARPDRIVE = {
	short: 'WarpDrive: S3 with an SSD tier in front',
	latency: '0.6 ms from the SSD tier, not 50–200 ms from S3',
} as const;

const DEPLOY = 'Rivet Cloud, BYOC or self-hosted';
const MIGRATE = { text: 'orange migrate moves Durable Objects live, with no downtime', mark: 'yes' } as const;

const CELLD_DOCS = 'https://github.com/denoland/celld/blob/8702f6d186c77698dbfb30cf29e3b1922a88f008/docs';

const celld: Comparison = {
	slug: 'celld',
	name: 'celld',
	title: `${SITE.name} vs celld`,
	description:
		'celld has had no release since Cloudflare acquired its developer. OpenOrange runs your Cloudflare project in production on Rivet, with storage that runs at SSD speed and stays online through S3 outages.',
	headline: 'celld was an experiment. OpenOrange is built for production.',
	lede: 'Both run Cloudflare Workers and Durable Objects on your own servers. celld went quiet after Cloudflare acquired its developer. OpenOrange runs on Rivet, which keeps shipping.',
	them: {
		name: 'celld',
		badge: { text: 'No release since Oct 21, 2026', tone: 'muted' },
		body: 'Self-hosted Workers and Durable Objects, built by Deno. It runs its own Workers runtime on V8 and keeps each active cell’s SQLite file on local disk, replicated to a bucket. Cloudflare acquired Deno in October 2026.',
	},
	us: {
		name: SITE.name,
		body: 'Your Cloudflare project in production, on your own cloud. The Workers API runs on Node.js. Rivet places every Durable Object across your machines, and WarpDrive stores its data on S3 behind an SSD tier.',
	},
	picks: [
		{
			title: 'Use OpenOrange when…',
			highlight: true,
			items: [
				'You run Cloudflare code in production.',
				'You need storage that’s fast, bottomless and online through S3 outages.',
				'You want a maintained project with support behind it.',
				'You’re moving a live app off Cloudflare without downtime.',
			],
		},
		{
			title: 'Use celld when…',
			items: [
				'You want to study a compact design for Durable Objects on one bucket.',
				'You’ll maintain your own fork, security fixes included.',
				'You need Python fetch handlers, which OpenOrange doesn’t run.',
			],
		},
	],
	matrix: {
		title: 'Side by side',
		rows: [
			{
				label: 'Maintained',
				them: {
					text: 'No release, commit or maintainer reply since Oct 21, 2026',
					mark: 'no',
					note: 'Only the latest release gets security fixes.',
				},
				us: { text: 'Yes, by Rivet, with paid support', mark: 'yes', note: 'Rivet has invested in this platform since December 2024.' },
			},
			{
				label: 'Production-ready',
				them: { text: 'Beta, by its own docs', mark: 'partial' },
				us: { text: 'Built for production on Rivet', mark: 'yes' },
			},
			{
				label: 'Runs your Cloudflare code as is',
				them: {
					text: 'Workers, Durable Objects, KV, D1, R2, Queues, Workflows and Cron',
					mark: 'partial',
					note: 'No Workers AI, Hyperdrive, Browser Rendering or Email.',
				},
				us: { text: `${CLOUDFLARE_APIS} Cloudflare APIs`, mark: 'yes', note: 'Workers AI, Hyperdrive, Browser Rendering and Email run on providers you choose.' },
			},
			{
				label: 'Durable Objects across machines',
				them: { text: 'Yes. Only hibernated cells move, placed by CPU count', mark: 'partial' },
				us: { text: 'Yes. Rivet places Actors across your machines', mark: 'yes' },
			},
			{
				label: 'Storage',
				them: { text: 'A local SQLite file per active cell, replicated to peers and a bucket' },
				us: { text: WARPDRIVE.short },
			},
			{
				label: 'Storage latency',
				them: {
					text: 'After a cell moves, its pages load from the bucket on first use',
					mark: 'partial',
					note: 'Until they’re filled in, “a large query can take minutes.”',
				},
				us: { text: WARPDRIVE.latency, mark: 'yes' },
			},
			{
				label: 'Database size',
				them: { text: 'Each active cell’s SQLite file sits on the node’s disk', mark: 'partial', note: 'No per-cell quota.' },
				us: { text: 'Not capped by host disk', mark: 'yes' },
			},
			{
				label: 'S3 outage',
				them: { text: 'The bucket holds every node lease and cell ownership record' },
				us: { text: 'Hot and new Actors stay online', mark: 'yes' },
			},
			{
				label: 'S3 request cost',
				them: { text: 'Each commit is uploaded to the bucket' },
				us: { text: 'SSD tiering cuts it by orders of magnitude', mark: 'yes' },
			},
			{
				label: 'Deploy targets',
				them: { text: 'Your servers, plus an S3, GCS or Azure bucket' },
				us: { text: DEPLOY, mark: 'yes' },
			},
			{
				label: 'Managed option',
				them: { text: 'Self-hosted only', mark: 'no' },
				us: { text: 'Rivet Cloud, or BYOC in your account', mark: 'yes' },
			},
			{
				label: 'Migrate a live app off Cloudflare',
				them: { text: 'Imports KV exports and D1 SQL', mark: 'partial', note: 'No Durable Object data import.' },
				us: MIGRATE,
			},
			{
				label: 'License',
				them: { text: 'Apache 2.0', note: 'Pull requests are disabled. Patches go by email.' },
				us: { text: 'Apache 2.0' },
			},
		],
		caption: 'celld v0.6.3, its last release. Storage figures for OpenOrange are WarpDrive’s, Rivet’s storage engine.',
	},
	timeline: {
		title: 'What happened to celld',
		lede: 'Cloudflare acquired Deno, celld’s developer. celld has been silent since its last release, and its engineers now build the same ideas into Cloudflare’s workerd.',
		events: [
			{
				date: 'Aug 5, 2026',
				iso: '2026-08-05',
				text: 'v0.1.0 starts a run of 12 releases in 11 weeks.',
				href: 'https://github.com/denoland/celld/releases/tag/v0.1.0',
			},
			{
				date: 'Oct 9, 2026',
				iso: '2026-10-09',
				text: 'Cloudflare announces that Deno is joining it: “we’re merging workerd and celld!”',
				href: 'https://blog.cloudflare.com/deno-joins-cloudflare/',
			},
			{
				date: 'Oct 12, 2026',
				iso: '2026-10-12',
				text: 'A user asks what celld’s future is. No maintainer answers.',
				href: 'https://github.com/denoland/celld/issues/267',
			},
			{
				date: 'Oct 21, 2026',
				iso: '2026-10-21',
				text: 'v0.6.3, the last release and the last maintainer comment.',
				href: 'https://github.com/denoland/celld/releases/tag/v0.6.3',
			},
			{
				date: 'Since',
				iso: '2026-11-12',
				text: 'No commits and no releases. 22 new issues, none answered. celld’s engineers commit to workerd, where PRs describe the work as “merging celld into workerd”.',
				href: 'https://github.com/denoland/celld/issues',
			},
		],
	},
	stats: {
		title: 'Storage that doesn’t wait on S3',
		lede: 'OpenOrange keeps every Durable Object, KV namespace, D1 database, Queue and Workflow on WarpDrive, Rivet’s storage engine. It’s backed by S3 and runs at SSD speed.',
		items: [
			{ value: '0.6 ms', label: 'Storage latency', body: 'S3 takes 50–200 ms. WarpDrive’s SSD tier answers in 0.6 ms.' },
			{ value: 'Bottomless', label: 'Database size', body: 'SQLite isn’t capped by the disk of the machine it runs on.' },
			{ value: '99.9%', label: 'S3’s uptime SLA', body: 'That allows almost 9 hours of downtime a year. Hot and new Actors stay online through it.' },
			{ value: 'Orders of magnitude', label: 'Lower S3 request cost', body: 'SSD tiering spreads each S3 request across many writes.' },
		],
	},
	sources: [
		{ label: 'Cloudflare: Deno is joining Cloudflare (Oct 9, 2026)', href: 'https://blog.cloudflare.com/deno-joins-cloudflare/' },
		{ label: 'TechCrunch: Cloudflare acquires Deno (Oct 10, 2026)', href: 'https://techcrunch.com/2026/10/10/cloudflare-acquires-deno-to-improve-its-workers-programming-model/' },
		{ label: 'celld v0.6.3 release', href: 'https://github.com/denoland/celld/releases/tag/v0.6.3' },
		{ label: 'celld issues', href: 'https://github.com/denoland/celld/issues' },
		{ label: 'celld security policy', href: `${CELLD_DOCS}/security.md` },
		{ label: 'celld limitations', href: `${CELLD_DOCS}/limitations.md` },
		{ label: 'celld guarantees', href: `${CELLD_DOCS}/guarantees.md` },
		{ label: 'celld Cloudflare compatibility', href: `${CELLD_DOCS}/cloudflare-compat.md` },
		{ label: 'workerd #7994: merging celld into workerd', href: 'https://github.com/cloudflare/workerd/pull/7994' },
	],
	cta: {
		title: 'Same Wrangler project. Built for production.',
		body: 'Run orange dev in your Worker project.',
		primary: { label: 'Get started', href: SITE.docs },
		secondary: { label: 'Talk to an engineer', href: SITE.talkToEngineer },
	},
};

const rivet: Comparison = {
	slug: 'rivet',
	name: 'Rivet',
	title: `${SITE.name} vs Rivet`,
	description:
		'OpenOrange is powered by Rivet. Starting from scratch? Use Rivet. Already have Cloudflare code? Use OpenOrange. Or keep your Workers on OpenOrange and add Rivet Actors.',
	headline: 'OpenOrange is powered by Rivet.',
	lede: 'Starting from scratch? Use Rivet. Already have Cloudflare code? Use OpenOrange. You can also use both.',
	them: {
		name: 'Rivet',
		badge: { text: 'Recommended for new projects', tone: 'good' },
		body: 'Open-source infrastructure for stateful backends and agents. Rivet Actors are long-lived processes with their own state and SQLite database. Rivet schedules and scales them, and WarpDrive stores their data on S3 behind an SSD tier.',
	},
	us: {
		name: SITE.name,
		badge: { text: 'For existing Cloudflare code', tone: 'good' },
		body: 'Runs Cloudflare Workers projects on Rivet. Every Durable Object, KV namespace, D1 database, Queue and Workflow runs as a Rivet Actor, behind the Cloudflare APIs your code already uses.',
	},
	picks: [
		{
			title: 'Use Rivet when…',
			lead: 'Its API is cleaner, more modern and more flexible than Cloudflare’s, with more features.',
			items: [
				'You’re starting a new backend or agent.',
				'You want typed actions, events and realtime connections built in.',
				'You want schedules and workflows inside every Actor.',
				'You want to fork an Actor and its SQLite database.',
				'You write Rust as well as TypeScript.',
			],
		},
		{
			title: 'Use OpenOrange when…',
			lead: 'Your Workers and Durable Objects run as they are.',
			items: [
				'You already have Workers, Durable Objects or other Cloudflare bindings.',
				'You want off Cloudflare without a rewrite.',
				'You’re moving a live app and can’t take downtime.',
				'Your team knows Wrangler: wrangler dev becomes orange dev.',
			],
		},
		{
			title: 'Use both when…',
			lead: 'Keep your existing code on OpenOrange and add Rivet Actors as you need them.',
			items: [
				'Your Cloudflare code works and you’re adding features.',
				'A new feature needs something only Rivet has, like realtime events or forking.',
				'You want one platform: both run on Rivet, with the same storage and deploy targets.',
			],
		},
	],
	matrix: {
		title: 'Side by side',
		rows: [
			{
				label: 'Best for',
				them: { text: 'New projects', mark: 'yes' },
				us: { text: 'Existing Cloudflare projects', mark: 'yes' },
			},
			{
				label: 'API',
				them: { text: 'Rivet Actors' },
				us: { text: 'Cloudflare Workers, Durable Objects and bindings' },
			},
			{
				label: 'Languages',
				them: { text: 'TypeScript and Rust' },
				us: { text: 'JavaScript and TypeScript' },
			},
			{
				label: 'Runtime',
				them: { text: 'Node.js or Bun' },
				us: { text: 'Node.js 22 or later' },
			},
			{
				label: 'Typed actions and events',
				them: { text: 'Built in', mark: 'yes' },
				us: { text: 'Durable Object RPC, with no built-in events', mark: 'partial' },
			},
			{
				label: 'Realtime connections',
				them: { text: 'Built in', mark: 'yes' },
				us: { text: 'WebSockets you wire up yourself', mark: 'partial' },
			},
			{
				label: 'Schedules and workflows',
				them: { text: 'Part of every Actor', mark: 'yes' },
				us: { text: 'Alarms, Cron Triggers and Workflows, as separate APIs', mark: 'yes' },
			},
			{
				label: 'Actor forking',
				them: { text: 'Fork an Actor and its SQLite database', mark: 'yes' },
				us: { text: 'Not in the Cloudflare API', mark: 'no' },
			},
			{
				label: 'Runs your Cloudflare code as is',
				them: { text: 'No. A different API', mark: 'no' },
				us: { text: `${CLOUDFLARE_APIS} Cloudflare APIs, from your Wrangler config`, mark: 'yes' },
			},
			{
				label: 'Migrate a live app off Cloudflare',
				them: { text: 'Rewrite it as Rivet Actors', mark: 'no' },
				us: MIGRATE,
			},
			{ label: 'Storage', same: WARPDRIVE.short },
			{ label: 'Deploy targets', same: DEPLOY },
			{ label: 'License', same: 'Apache 2.0' },
			{ label: 'Maintained by', same: 'Rivet' },
		],
	},
	sources: [
		{ label: 'Rivet docs', href: `${SITE.rivet}/docs/` },
		{ label: 'Rivet: actor forking for SQLite (Nov 11, 2026)', href: `${SITE.rivet}/changelog/2026-11-11-introducing-actor-forking-for-sqlite/` },
		{ label: 'OpenOrange: what runs where', href: SITE.docsBindings },
	],
	cta: {
		title: 'Start with the one that fits.',
		body: 'New project: build on Rivet. Cloudflare code: bring it to OpenOrange.',
		primary: { label: 'Start with Rivet', href: `${SITE.rivet}/docs/` },
		secondary: { label: 'Run your Cloudflare code', href: SITE.docs },
	},
};

const miniflare: Comparison = {
	slug: 'miniflare',
	name: 'Miniflare',
	title: `${SITE.name} vs Miniflare`,
	description:
		'Miniflare simulates Workers on your machine so you can ship to Cloudflare. OpenOrange runs your Cloudflare project in production on your own cloud.',
	headline: 'Miniflare tests Workers. OpenOrange runs them in production.',
	lede: 'Miniflare simulates Workers on your machine so you can ship to Cloudflare. OpenOrange runs your Cloudflare project in production, on your own cloud.',
	them: {
		name: 'Miniflare',
		badge: { text: 'Development and testing', tone: 'muted' },
		body: 'Cloudflare’s simulator for developing and testing Workers. It runs your code on a local workerd process. Few people call it directly anymore: wrangler dev and Cloudflare’s Vite plugin run workerd for you.',
	},
	us: {
		name: SITE.name,
		body: 'Your Cloudflare project in production, on your own cloud. The Workers API runs on Node.js, and Rivet provides Durable Objects, storage and every other service. orange dev runs the same runtime on your machine.',
	},
	picks: [
		{
			title: 'Use OpenOrange when…',
			highlight: true,
			items: [
				'You want your Cloudflare project in production, off Cloudflare.',
				'You want local dev on the same runtime you deploy.',
				'You need Durable Objects across machines and durable storage.',
				'You’re moving a live app off Cloudflare.',
			],
		},
		{
			title: 'Use Miniflare when…',
			items: [
				'You deploy to Cloudflare and want to test Workers on your machine.',
				'You run it through wrangler dev or Cloudflare’s Vitest integration.',
				'You need its API for an advanced test setup.',
			],
		},
	],
	matrix: {
		title: 'Side by side',
		rows: [
			{
				label: 'Built for',
				them: { text: 'Local development and testing' },
				us: { text: 'Production, plus local dev with orange dev' },
			},
			{
				label: 'Runs your Cloudflare code as is',
				them: { text: 'On your machine, on workerd', mark: 'yes' },
				us: { text: 'On your machine and in production', mark: 'yes' },
			},
			{
				label: 'Production-ready',
				them: { text: 'No. It’s a simulator', mark: 'no', note: 'Cloudflare: “not a security boundary for untrusted code.”' },
				us: { text: 'Built for production on Rivet', mark: 'yes' },
			},
			{
				label: 'Durable Objects across machines',
				them: { text: 'One local workerd process', mark: 'no' },
				us: { text: 'Rivet places Actors across your machines', mark: 'yes' },
			},
			{
				label: 'Storage',
				them: { text: 'Local, for development', mark: 'no' },
				us: { text: WARPDRIVE.short, mark: 'yes' },
			},
			{
				label: 'Deploy targets',
				them: { text: 'None. You deploy to Cloudflare', mark: 'no' },
				us: { text: DEPLOY, mark: 'yes' },
			},
			{
				label: 'Migrate a live app off Cloudflare',
				them: { text: 'No', mark: 'no' },
				us: MIGRATE,
			},
			{
				label: 'Maintained',
				them: { text: 'Yes, by Cloudflare, with Wrangler', mark: 'yes' },
				us: { text: 'Yes, by Rivet', mark: 'yes' },
			},
		],
	},
	sources: [{ label: 'Cloudflare: Miniflare', href: 'https://developers.cloudflare.com/workers/testing/miniflare/' }],
	cta: {
		title: 'Same Worker. Now in production.',
		body: 'Run orange dev in your Worker project.',
	},
};

// Footer order.
export const COMPARISONS: Comparison[] = [celld, miniflare, rivet];
