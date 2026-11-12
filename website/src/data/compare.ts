// Copy for the comparison pages /vs-durable-objects/, /vs-celld/, /vs-rivet/
// and /vs-miniflare/, rendered by src/pages/vs-[competitor].astro.
// /vs-workerd/ has its own page and its data lives in site.ts.
//
// Every claim about another project is sourced, and the page lists its
// sources. Durable Objects claims come from Cloudflare's docs and its June 12,
// 2025 incident report, read on 2026-11-12; the limit values are LIMITS in
// site.ts. celld claims come from celld v0.6.3 (8702f6d, 2026-10-21), its
// docs, source, issues and releases, and press coverage of the acquisition, as
// read on 2026-11-12. Miniflare claims come from Cloudflare's Miniflare docs,
// read on 2026-11-12. Rivet claims come from rivet.dev. Re-check them before
// changing AS_OF.

import { LIMITS, MODULES, SITE } from './site';

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
/** A sentence quoted from the other product's docs, with when it applies. */
export type Quote = { quote: string; when: string; href: string };
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
	quotes?: { title: string; lede: string; items: Quote[] };
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

// Cloudflare's limits and OpenOrange's, as the landing page's limits table states them.
const limit = (id: string) => {
	const row = LIMITS.find((r) => r.id === id);
	if (!row) throw new Error(`No LIMITS row named ${id}`);
	return row;
};
const MEMORY = { text: limit('memory').openorange, note: limit('memory').note, mark: 'yes' } as const;
const NODE = { text: 'Stock Node.js 22 or later', mark: 'yes' } as const;
const NEXT_TO_DB = { text: 'In your VPC, next to it', mark: 'yes' } as const;

const CELLD_DOCS = 'https://github.com/denoland/celld/blob/8702f6d186c77698dbfb30cf29e3b1922a88f008/docs';

const celld: Comparison = {
	slug: 'celld',
	name: 'celld',
	title: `${SITE.name} vs celld`,
	description:
		'OpenOrange runs your Cloudflare project in production on Rivet, with storage that runs at SSD speed and stays online through S3 outages. celld has had no release since Cloudflare acquired its developer.',
	headline: 'OpenOrange is built for production. celld was an experiment.',
	lede: 'Both run Cloudflare Workers and Durable Objects on your own servers. OpenOrange runs on Rivet, which keeps shipping. celld went quiet after Cloudflare acquired its developer.',
	them: {
		name: 'celld',
		badge: { text: 'No release since Oct 21, 2026', tone: 'muted' },
		body: 'Self-hosted Workers and Durable Objects, built by Deno. It runs its own Workers runtime on V8 and keeps each active cell’s SQLite file on local disk, replicated to a bucket. It imports KV and D1, but not your Durable Object data. Cloudflare acquired Deno in October 2026.',
	},
	us: {
		name: SITE.name,
		body: 'Your Cloudflare project in production, on your own cloud. The Workers API runs on Node.js. Rivet places every Durable Object across your machines, and WarpDrive stores its data on S3 behind an SSD tier. Cloudflare locks your data in. OpenOrange opens it up and live-migrates it, with zero downtime for Durable Objects.',
	},
	picks: [
		{
			title: 'Use OpenOrange when…',
			highlight: true,
			items: [
				'You run Cloudflare code in production.',
				'You need storage that’s fast, bottomless and online through S3 outages.',
				'You want a maintained project with support behind it.',
				'You run untrusted code in sandboxes on E2B, Daytona, Freestyle or agentOS.',
				'You’re live-migrating an app off Cloudflare, or between OpenOrange clusters.',
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
				them: { text: 'No release, commit or maintainer reply since Oct 21, 2026', mark: 'no' },
				us: { text: 'Yes, by Rivet, with paid support', mark: 'yes', note: 'Rivet has invested in this platform since December 2024.' },
			},
			{
				label: 'Security fixes',
				them: { text: 'Latest release only, and none since Oct 21', mark: 'no', note: '“Only the latest release receives security fixes.”' },
				us: { text: 'Yes, from Rivet', mark: 'yes' },
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
				label: 'Node.js',
				them: { text: 'A listed subset of node: modules', mark: 'partial', note: 'Other node: modules import, then throw on first call.' },
				us: NODE,
			},
			{
				label: 'Sandboxes for untrusted code',
				them: { text: 'Docker or Podman on each node', mark: 'partial', note: 'By default a container shares the node’s kernel. Experimental.' },
				us: { text: 'E2B, Daytona, Freestyle or agentOS', mark: 'yes', note: 'E2B, Freestyle and agentOS run each sandbox in a VM.' },
			},
			{
				label: 'Memory',
				them: { text: '128 MB heap per isolate by default', mark: 'partial', note: 'Configurable. Over 90%, new hibernatable WebSockets are refused.' },
				us: MEMORY,
			},
			{
				label: 'CPU and alarm time',
				them: { text: 'Not documented' },
				us: { text: 'No cap', mark: 'yes' },
			},
			{
				label: 'Durable Objects across machines',
				them: { text: 'Yes. Only hibernated cells move, placed by CPU count', mark: 'partial' },
				us: { text: 'Yes. Rivet places Actors across your machines', mark: 'yes' },
			},
			{
				label: 'Fork an Actor or Durable Object with its state',
				them: { text: 'No', mark: 'no' },
				us: { text: 'Yes, with Rivet Actors beside your Workers', mark: 'yes' },
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
				label: 'Latency to your database',
				them: { text: 'On your servers, without Hyperdrive', mark: 'partial', note: 'Workers that reach their database through Hyperdrive need changes.' },
				us: { ...NEXT_TO_DB, note: 'Hyperdrive works unchanged.' },
			},
			{
				label: 'Database size',
				them: { text: 'Bound by the node’s disk', mark: 'partial', note: 'No per-cell quota.' },
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
				label: 'Live migration of your data',
				them: {
					text: 'No. Imports KV exports and D1 SQL only',
					mark: 'no',
					note: 'No Durable Object data import. Some v0.6.0 upgrades meant stopping the whole fleet.',
				},
				us: { ...MIGRATE, note: 'Off Cloudflare, or between OpenOrange clusters.' },
			},
			{
				label: 'License',
				them: { text: 'Apache 2.0', note: 'Pull requests are disabled. Patches go by email.' },
				us: { text: 'Apache 2.0' },
			},
		],
		caption: 'Storage figures for OpenOrange are WarpDrive’s, Rivet’s storage engine. celld as of v0.6.3, its last release.',
	},
	timeline: {
		title: 'What happened to celld',
		lede: 'Cloudflare acquired Deno, celld’s developer. celld has been silent since its last release.',
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
				text: 'Cloudflare announces that Deno, celld’s developer, is joining it.',
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
				text: 'No commits and no releases. 22 new issues, none answered.',
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
			{ value: 'Beyond S3’s 99.9%', label: 'Availability', body: 'The SSD layer keeps hot and new Actors online when S3 is down.' },
			{ value: 'Orders of magnitude', label: 'Lower S3 request cost', body: 'SSD tiering spreads each S3 request across many writes.' },
		],
	},
	sources: [
		{ label: 'TechCrunch: Cloudflare acquires Deno (Oct 10, 2026)', href: 'https://techcrunch.com/2026/10/10/cloudflare-acquires-deno-to-improve-its-workers-programming-model/' },
		{ label: 'celld v0.6.3 release', href: 'https://github.com/denoland/celld/releases/tag/v0.6.3' },
		{ label: 'celld issues', href: 'https://github.com/denoland/celld/issues' },
		{ label: 'celld security policy', href: `${CELLD_DOCS}/security.md` },
		{ label: 'celld limitations', href: `${CELLD_DOCS}/limitations.md` },
		{ label: 'celld guarantees', href: `${CELLD_DOCS}/guarantees.md` },
		{ label: 'celld Cloudflare compatibility', href: `${CELLD_DOCS}/cloudflare-compat.md` },
		{ label: 'celld containers', href: `${CELLD_DOCS}/services/containers.md` },
		{ label: 'celld README: memory limits', href: `${CELLD_DOCS.replace(/\/docs$/, '')}/README.md#operate-a-fleet` },
		{ label: 'celld v0.6.0 release', href: 'https://github.com/denoland/celld/releases/tag/v0.6.0' },
		{ label: 'Rivet: forking', href: `${SITE.rivet}/actors/docs/forking/` },
		{ label: 'OpenOrange: migrate from Cloudflare', href: SITE.docsMigrate },
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
		'OpenOrange is powered by Rivet. Already have Cloudflare code? Use OpenOrange. Starting from scratch? Use Rivet. Or keep your Workers on OpenOrange and add Rivet Actors.',
	headline: 'OpenOrange is powered by Rivet.',
	lede: 'Already have Cloudflare code? Use OpenOrange. Starting from scratch? Use Rivet. You can also use both.',
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
			title: 'Use OpenOrange when…',
			highlight: true,
			lead: 'Your Workers and Durable Objects run as they are.',
			items: [
				'You already have Workers, Durable Objects or other Cloudflare bindings.',
				'You want off Cloudflare without a rewrite.',
				'You’re moving a live app and can’t take downtime.',
				'Your team knows Wrangler: wrangler dev becomes orange dev.',
			],
		},
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
		body: 'Cloudflare code: bring it to OpenOrange. New project: build on Rivet.',
		primary: { label: 'Run your Cloudflare code', href: SITE.docs },
		secondary: { label: 'Start with Rivet', href: `${SITE.rivet}/docs/` },
	},
};

const miniflare: Comparison = {
	slug: 'miniflare',
	name: 'Miniflare',
	title: `${SITE.name} vs Miniflare`,
	description:
		'OpenOrange runs your Cloudflare project in production on your own cloud. Miniflare simulates Workers on your machine so you can ship to Cloudflare.',
	headline: 'OpenOrange runs Workers in production. Miniflare tests them.',
	lede: 'OpenOrange runs your Cloudflare project in production, on your own cloud. Miniflare simulates Workers on your machine so you can ship to Cloudflare.',
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

// Cloudflare's docs, as read on 2026-11-12.
const CF_DOCS = 'https://developers.cloudflare.com';
const DO_LIMITS = `${CF_DOCS}/durable-objects/platform/limits/`;
const DO_ERRORS = `${CF_DOCS}/durable-objects/observability/troubleshooting/`;
const DO_LOCATION = `${CF_DOCS}/durable-objects/reference/data-location/`;

const durableObjects: Comparison = {
	slug: 'durable-objects',
	name: 'Durable Objects',
	title: `${SITE.name} vs Cloudflare Durable Objects`,
	description:
		'OpenOrange runs your Cloudflare Durable Objects in your own cloud, next to your database, without the 128 MB memory, CPU or 10 GB storage caps, and live-migrates them off Cloudflare with zero downtime.',
	headline: 'OpenOrange runs Durable Objects in your cloud, without Cloudflare’s limits.',
	lede: 'Same code. OpenOrange runs it in your VPC, next to your database, on infrastructure you control.',
	them: {
		name: 'Durable Objects',
		badge: { text: 'Runs only on Cloudflare', tone: 'muted' },
		body: 'Cloudflare’s stateful Workers. Each object runs on one thread on Cloudflare’s network, with 128 MB of memory and up to 10 GB of SQLite storage. Cloudflare picks the data center and updates the runtime on its own schedule.',
	},
	us: {
		name: SITE.name,
		body: 'The same Durable Objects, on your own cloud. Rivet places each object across your machines, next to your database, with your machine’s memory and no CPU or storage cap. Cloudflare locks your data in. OpenOrange opens it up and live-migrates it, with zero downtime.',
	},
	picks: [
		{
			title: 'Use OpenOrange when…',
			highlight: true,
			items: [
				'Your database runs in AWS, GCP or Azure, and p99s matter.',
				'You’ve outgrown 128 MB of memory, 5 minutes of CPU or 10 GB per object.',
				'Your data has to stay in your cloud account or on your own servers.',
				'You want to own your uptime, deploys and redundancy.',
				'Your npm packages need stock Node.js.',
				'You’re moving a live app off Cloudflare, with zero downtime.',
			],
		},
		{
			title: 'Use Durable Objects when…',
			items: [
				'You have no infrastructure of your own, and don’t want any.',
				'Your objects fit in 128 MB of memory and 10 GB of storage.',
				'You have no strict latency, uptime or data-residency needs.',
			],
		},
	],
	matrix: {
		title: 'Side by side',
		rows: [
			{
				label: 'Latency to your database',
				them: { text: 'Every query crosses the internet', mark: 'no', note: 'Location hints are “best effort and not a guarantee.”' },
				us: { ...NEXT_TO_DB, note: 'No trip across the internet, so p99s stay steady.' },
			},
			{
				label: 'Where it runs',
				them: { text: 'Cloudflare’s network only', mark: 'no', note: 'Not on-prem, and not in your cloud account.' },
				us: { text: 'Rivet Cloud, your AWS, GCP or Azure account, or your own servers', mark: 'yes' },
			},
			{
				label: 'Data residency',
				them: { text: 'EU, US or FedRAMP jurisdictions', mark: 'partial', note: 'Object IDs are still logged outside the jurisdiction.' },
				us: { text: 'The region and account you choose', mark: 'yes' },
			},
			{
				label: 'Uptime',
				them: { text: 'Tied to Cloudflare’s platform', note: 'In its June 12, 2025 outage, SQLite-backed objects’ errors peaked at 22%.' },
				us: { text: 'Your infrastructure, your redundancy', mark: 'yes' },
			},
			{
				label: 'Runtime updates',
				them: { text: 'On Cloudflare’s schedule', mark: 'no', note: 'Open connections get up to 20 minutes, then close.' },
				us: { text: 'When you deploy', mark: 'yes' },
			},
			{
				label: 'Object resets',
				them: { text: 'On code updates, slow storage and overload', mark: 'no', note: 'Cloudflare’s own wording is below.' },
				us: { text: 'On your machines, on your schedule', mark: 'yes' },
			},
			{
				label: 'Memory per object',
				them: { text: limit('memory').cloudflare, mark: 'partial' },
				us: MEMORY,
			},
			{
				label: 'CPU time per request',
				them: { text: limit('cpu').cloudflare, mark: 'partial' },
				us: { text: limit('cpu').openorange, mark: 'yes' },
			},
			{
				label: 'Storage per object',
				them: { text: limit('storage').cloudflare, mark: 'partial', note: 'Writes then fail with SQLITE_FULL.' },
				us: { text: limit('storage').openorange, mark: 'yes' },
			},
			{
				label: 'Requests per object',
				them: { text: 'About 1,000 per second, a soft limit', mark: 'partial', note: 'Past it, the object returns “overloaded” errors.' },
				us: { text: 'No set limit', mark: 'yes' },
			},
			{
				label: 'Alarm wall time',
				them: { text: '15 minutes', mark: 'partial' },
				us: { text: limit('wall-time').openorange, mark: 'yes' },
			},
			{
				label: 'Node.js',
				them: { text: 'The nodejs_compat subset', mark: 'partial', note: 'Some modules are shims that throw when called.' },
				us: NODE,
			},
			{
				label: 'Live migration of your data',
				them: { text: 'Locked in to Cloudflare', mark: 'no' },
				us: { ...MIGRATE, note: 'SQLite-backed objects, straight off Cloudflare.' },
			},
			{ label: 'Your code', same: 'Your Durable Object classes and wrangler config, unchanged' },
		],
		caption: 'Cloudflare figures are for the Workers Paid plan, from Cloudflare’s docs.',
	},
	quotes: {
		title: 'Cloudflare resets your objects.',
		lede: 'Its own docs say when. On OpenOrange, you control the machines and when deploys happen.',
		items: [
			{
				quote: 'Durable Object reset because its code was updated.',
				when: 'A deploy lands before the object hibernates.',
				href: `${DO_ERRORS}#durable-object-reset-because-its-code-was-updated`,
			},
			{
				quote: 'Durable Object storage operation exceeded timeout which caused object to be reset.',
				when: 'A storage call runs too long.',
				href: `${DO_ERRORS}#durable-object-storage-operation-exceeded-timeout-which-caused-object-to-be-reset`,
			},
			{
				quote: 'Durable Object is overloaded. Too many requests queued.',
				when: 'One object gets more work than one thread can do.',
				href: `${DO_ERRORS}#durable-object-is-overloaded`,
			},
			{
				quote: '…there is a heightened chance that the individual Durable Object is evicted and reset.',
				when: 'It uses more than 30 seconds of CPU between requests.',
				href: DO_LIMITS,
			},
		],
	},
	sources: [
		{ label: 'Cloudflare: Durable Objects limits', href: DO_LIMITS },
		{ label: 'Cloudflare: Workers limits', href: `${CF_DOCS}/workers/platform/limits/` },
		{ label: 'Cloudflare: Durable Objects troubleshooting', href: DO_ERRORS },
		{ label: 'Cloudflare: Durable Objects data location', href: DO_LOCATION },
		{ label: 'Cloudflare: Node.js compatibility', href: `${CF_DOCS}/workers/runtime-apis/nodejs/` },
		{ label: 'Cloudflare: June 12, 2025 service outage', href: 'https://blog.cloudflare.com/cloudflare-service-outage-june-12-2025/' },
		{ label: 'Cloudflare status', href: 'https://www.cloudflarestatus.com/' },
		{ label: 'OpenOrange: deploy and self-host', href: SITE.docsDeploy },
		{ label: 'OpenOrange: migrate from Cloudflare', href: SITE.docsMigrate },
	],
	cta: {
		title: 'Same Durable Objects. Next to your database.',
		body: 'Run orange dev in your Worker project.',
		primary: { label: 'Get started', href: SITE.docs },
		secondary: { label: 'Migrate from Cloudflare', href: SITE.docsMigrate },
	},
};

// Footer order.
export const COMPARISONS: Comparison[] = [durableObjects, celld, miniflare, rivet];
