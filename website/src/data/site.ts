// Every piece of copy and every number on the site lives here so that a
// positioning change is one edit. Numbers about Cloudflare carry a `source`
// so they can be re-checked; the `verified` date is when they were last read
// from Cloudflare's docs.

export const SITE = {
	name: 'OpenOrange',
	domain: 'openorange.dev',
	tagline: 'Your Cloudflare project. Region: your datacenter.',
	description:
		'OpenOrange runs your Cloudflare Workers, Durable Objects, KV, Queues and Workflows unchanged on AWS, GCP, Azure or your own servers. Open source. wrangler dev becomes openorange dev.',
	github: 'https://github.com/rivet-dev/open-orange',
	// /docs/ renders the repository's docs/*.mdx.
	docs: '/docs/',
	docsMigrate: '/docs/migrate/',
	docsBindings: '/docs/bindings/',
	docsDeploy: '/docs/deploy/',
	migrator: 'https://github.com/rivet-dev/durable-object-migrator',
	rivet: 'https://rivet.dev',
	rivetDashboard: 'https://dashboard.rivet.dev',
	talkToEngineer: 'https://rivet.dev/talk-to-an-engineer/',
	verified: '2026-10-08',
} as const;

export const NAV = [
	{ label: 'Documentation', href: SITE.docs },
	{ label: 'Bindings', href: '/docs/bindings/' },
	{ label: 'Startups', href: '/startups/' },
	{ label: 'Enterprise', href: '/enterprise/' },
] as const;

export const HERO = {
	title: 'Run Cloudflare Workers anywhere.',
	lede: 'The same developer experience, without the runtime limits, for a fraction of the bill.',
	tagline: 'Built for serious scale.',
	before: 'wrangler dev',
	after: 'openorange dev',
} as const;

export type LimitRow = {
	limit: string;
	cloudflare: string;
	openorange: string;
	/** The full limit, shown on hover. */
	detail: string;
	source?: string;
};

// Workers Paid plan values. Free plan values are stricter.
export const LIMITS: LimitRow[] = [
	{
		limit: 'Memory',
		cloudflare: '128 MB',
		openorange: 'Your instance',
		detail: 'Memory per Worker isolate. Each Durable Object has the same 128 MB cap.',
		source: 'https://developers.cloudflare.com/workers/platform/limits/#memory',
	},
	{
		limit: 'CPU time',
		cloudflare: '5 min',
		openorange: 'No limit',
		detail: 'CPU time per request: 30 seconds by default, 5 minutes at most.',
		source: 'https://developers.cloudflare.com/workers/platform/limits/#cpu-time',
	},
	{
		limit: 'Connections',
		cloudflare: '6',
		openorange: 'OS limits',
		detail: 'Simultaneous outgoing connections per request. Extra fetch() calls wait for a free one.',
		source: 'https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections',
	},
	{
		limit: 'Wall time',
		cloudflare: '15 min',
		openorange: 'No limit',
		detail: 'Cron, queue and alarm handlers stop after 15 minutes of wall time.',
		source: 'https://developers.cloudflare.com/workers/platform/limits/#duration',
	},
	{
		limit: 'Bundle size',
		cloudflare: '64 MiB',
		openorange: 'No limit',
		detail: 'The largest Worker bundle Cloudflare accepts.',
		source: 'https://developers.cloudflare.com/workers/platform/limits/#worker-size',
	},
	{
		limit: 'Node.js',
		cloudflare: 'A subset',
		openorange: 'Stock Node.js',
		detail: 'Cloudflare runs part of the Node.js API behind nodejs_compat. OpenOrange runs stock Node.js, with a few node: modules swapped for workerd-shaped versions so Workers code behaves the same.',
	},
	{
		limit: 'p99 latency',
		cloudflare: 'Edge ↔ DB',
		openorange: 'Next to DB',
		detail: 'Run next to your database instead of crossing the internet on every query. No CPU cap cuts a slow request short, and no memory ceiling evicts a busy object, so p99s stay steady.',
	},
];

export type MeterRow = { meter: string; price: string };

// Cloudflare's published Workers Paid and Durable Objects prices.
export const CLOUDFLARE_METERS: MeterRow[] = [
	{ meter: 'Workers requests', price: '$0.30 / million' },
	{ meter: 'Workers CPU time', price: '$0.02 / million ms' },
	{ meter: 'Durable Object requests', price: '$0.15 / million' },
	{ meter: 'Durable Object duration', price: '$12.50 / million GB-s' },
	{ meter: 'SQLite rows read', price: '$0.001 / million' },
	{ meter: 'SQLite rows written', price: '$1.00 / million' },
	{ meter: 'Stored data', price: '$0.20 / GB-month' },
	{ meter: 'Plan minimum', price: '$5 / month' },
];

// The cost section converts Cloudflare's meters to raw AWS prices, unit for
// unit, on ARM (Graviton). Compute runs on EC2 with 40% headroom for
// autoscaling: a Durable Object GB-hour becomes 1.4 GB-hours of r7g (memory
// optimized), a Workers CPU-hour becomes 1.4 vCPU-hours of c7g. Durable
// Objects, D1, KV, Queues and Workflows all keep their state in actor SQLite,
// stored in S3 in your account. Writes cost S3 requests, amortized across
// many writes; WRITE_ESTIMATE is that cost per write, from one measured run.
// AWS: on-demand Linux, us-east-1. Cloudflare: Workers Paid pricing pages.
const HEADROOM = 1.4;
const R7G_XLARGE = { name: 'r7g.xlarge', hourly: 0.2142, vcpu: 4, memoryGb: 32 };
const C7G_XLARGE = { name: 'c7g.xlarge', hourly: 0.145, vcpu: 4, memoryGb: 8 };
const S3_STORAGE = 0.023;
// Measured on Rivet Engine, 6 nodes: 5,000 concurrent agents, each awake 60 s
// writing one 64-byte SQLite upsert every 10 s, then sleeping with its data
// kept. 150,189 writes per 5 minutes (1.32 billion a month) made $232 a month
// of object-storage requests at S3 rates (PUT/LIST $0.005, GET $0.0004 per
// 1,000). Storage bytes and compute are excluded.
export const WRITE_ESTIMATE = {
	agents: 5000,
	nodes: 6,
	writesPerMonth: (150_189 / 5) * 60 * 730,
	requestCostPerMonth: 232,
	get perMillion() {
		return this.requestCostPerMonth / (this.writesPerMonth / 1_000_000);
	},
};

export type CostMeter = {
	id: string;
	title: string;
	unit: string;
	cloudflare: number;
	cloudflareNote: string;
	openorange: number;
	openorangeNote: string;
};

const storage = (id: string, title: string, cloudflare: number): CostMeter => ({
	id,
	title,
	unit: 'GB-month',
	cloudflare,
	cloudflareNote: `$${cloudflare.toFixed(2)} per GB-month`,
	openorange: S3_STORAGE,
	openorangeNote: 'S3 Standard in your account',
});
// A write-type operation, priced at `writes` actor SQLite writes each.
const writes = (id: string, title: string, unit: string, cloudflare: number, cloudflareNote: string, count: number, what: string): CostMeter => ({
	id,
	title,
	unit,
	cloudflare,
	cloudflareNote,
	openorange: WRITE_ESTIMATE.perMillion * count,
	openorangeNote: `${what}, at the measured S3 request cost per write`,
});

export const COST = {
	headroom: HEADROOM,
	groups: [
		{
			title: 'Compute',
			meters: [
				{
					id: 'durable-objects',
					title: 'Durable Object compute',
					unit: 'GB-hour',
					cloudflare: (12.5 / 1_000_000) * 3600,
					cloudflareNote: '$12.50 per million GB-s',
					openorange: (R7G_XLARGE.hourly / R7G_XLARGE.memoryGb) * HEADROOM,
					openorangeNote: `${R7G_XLARGE.name} (Graviton), ${R7G_XLARGE.memoryGb} GB for $${R7G_XLARGE.hourly}/h, plus 40% headroom`,
				},
				{
					id: 'workers',
					title: 'Workers compute',
					unit: 'vCPU-hour',
					cloudflare: (0.02 / 1_000_000) * 3_600_000,
					cloudflareNote: '$0.02 per million CPU-ms, plus $0.30 per million requests',
					openorange: (C7G_XLARGE.hourly / C7G_XLARGE.vcpu) * HEADROOM,
					openorangeNote: `${C7G_XLARGE.name} (Graviton), ${C7G_XLARGE.vcpu} vCPU for $${C7G_XLARGE.hourly}/h, plus 40% headroom. No request fee.`,
				},
			],
		},
		{
			title: 'Storage',
			meters: [
				storage('do-sqlite-storage', 'Durable Object SQLite', 0.2),
				storage('d1-storage', 'D1', 0.75),
				storage('kv-storage', 'KV', 0.5),
				storage('workflows-storage', 'Workflows', 0.2),
			],
		},
		{
			title: 'Writes',
			meters: [
				writes('sqlite-writes', 'SQLite rows written', 'million rows', 1, '$1.00 per million rows, Durable Objects and D1', 1, 'One SQLite write per row'),
				writes('kv-writes', 'KV writes', 'million writes', 5, '$5.00 per million writes, deletes or lists', 1, 'One SQLite write per KV write'),
				writes('queues', 'Queues messages', 'million messages', 1.2, '$0.40 per million operations, 3 per message', 2, 'Two SQLite writes per message, send and ack'),
				writes('workflow-steps', 'Workflows steps', 'million steps', 8, '$0.80 per 100,000 steps', 1, 'A few SQLite rows per step: log, state and result'),
			],
		},
	] satisfies { title: string; meters: CostMeter[] }[],
	source: {
		durableObjects: 'https://developers.cloudflare.com/durable-objects/platform/pricing/',
		workers: 'https://developers.cloudflare.com/workers/platform/pricing/',
		ec2: 'https://aws.amazon.com/ec2/pricing/on-demand/',
	},
} as const;

const meter = (id: string) => COST.groups.flatMap((g) => g.meters).find((m) => m.id === id)!;
// Headline multiples: compute is Durable Object GB-hours 1:1; the database is
// Durable Object SQLite storage, the lowest of the storage multiples.
export const CHEAPER_COMPUTE = meter('durable-objects').cloudflare / meter('durable-objects').openorange;
export const CHEAPER_DATABASE = meter('do-sqlite-storage').cloudflare / meter('do-sqlite-storage').openorange;

// What else lands on the bill.
export const COST_EXTRAS = [
	{
		title: 'No egress tax',
		body: 'Traffic inside your VPC is free. Every call from Cloudflare back to your database or APIs in AWS pays AWS egress, $0.09 per GB.',
	},
	{
		title: 'Spend the credits you already have',
		body: 'AWS, Google and Azure credits and committed spend pay for OpenOrange. Cloudflare is a second bill.',
	},
] as const;

export type ServiceStatus = 'drop-in' | 'pluggable' | 'partial' | 'planned';

/** A service a pluggable binding runs on. */
export type Provider = { name: string; href: string };

// The services each pluggable binding is known to work with. List only
// services that have been run against the binding. Hosted services first;
// local options are listed under them.
export const PROVIDERS: Record<string, { hosted: Provider[]; local: Provider[]; note?: string }> = {
	'browser-rendering': {
		hosted: [
			{ name: 'Browserbase', href: 'https://www.browserbase.com/' },
			{ name: 'Browserless', href: 'https://www.browserless.io/' },
			{ name: 'Steel', href: 'https://steel.dev/' },
		],
		local: [
			{ name: 'Headless Chrome', href: 'https://developer.chrome.com/docs/chromium/headless' },
		],
		note: 'Any Chrome DevTools Protocol endpoint, set in ORANGE_BROWSER_CDP_URL.',
	},
	'send-email': {
		hosted: [
			{ name: 'Resend', href: 'https://resend.com/' },
			{ name: 'Amazon SES', href: 'https://aws.amazon.com/ses/' },
			{ name: 'Postmark', href: 'https://postmarkapp.com/' },
			{ name: 'SendGrid', href: 'https://sendgrid.com/' },
			{ name: 'Mailgun', href: 'https://www.mailgun.com/' },
		],
		local: [
			{ name: 'Mailpit', href: 'https://mailpit.axllent.org/' },
		],
		note: 'Any SMTP server, set in ORANGE_EMAIL_SMTP_URL. Inbound mail arrives on /cdn-cgi/handler/email.',
	},
	sandboxes: {
		hosted: [
			{ name: 'E2B', href: 'https://e2b.dev/' },
			{ name: 'Daytona', href: 'https://www.daytona.io/' },
			{ name: 'Freestyle', href: 'https://www.freestyle.sh/' },
		],
		local: [
			{ name: 'agentOS VM', href: 'https://github.com/rivet-dev/agentos' },
			{ name: 'Local directory', href: 'https://github.com/rivet-dev/open-orange/blob/main/docs/modules/sandbox.mdx' },
		],
		note: 'Pick one with ORANGE_SANDBOX_PROVIDER.',
	},
	'workers-ai': {
		hosted: [
			{ name: 'OpenRouter', href: 'https://openrouter.ai/' },
			{ name: 'OpenAI', href: 'https://platform.openai.com/' },
			{ name: 'Groq', href: 'https://groq.com/' },
			{ name: 'Together AI', href: 'https://www.together.ai/' },
			{ name: 'Fireworks AI', href: 'https://fireworks.ai/' },
		],
		local: [
			{ name: 'Ollama', href: 'https://ollama.com/' },
		],
		note: 'Any OpenAI-compatible endpoint, set in ORANGE_AI_BASE_URL. Text and embedding models.',
	},
	r2: {
		hosted: [
			{ name: 'Amazon S3', href: 'https://aws.amazon.com/s3/' },
			{ name: 'Google Cloud Storage', href: 'https://cloud.google.com/storage/docs/interoperability' },
			{ name: 'Cloudflare R2', href: 'https://developers.cloudflare.com/r2/' },
			{ name: 'Backblaze B2', href: 'https://www.backblaze.com/cloud-storage' },
		],
		local: [
			{ name: 'Actor storage', href: 'https://github.com/rivet-dev/open-orange/blob/main/docs/modules/r2.mdx' },
			{ name: 'MinIO', href: 'https://min.io/' },
		],
		note: 'Any S3-compatible store, set per bucket with ORANGE_R2_<BUCKET>_S3_*.',
	},
	hyperdrive: {
		hosted: [
			{ name: 'Neon', href: 'https://neon.com/' },
			{ name: 'Supabase', href: 'https://supabase.com/' },
			{ name: 'Amazon RDS', href: 'https://aws.amazon.com/rds/' },
			{ name: 'PlanetScale', href: 'https://planetscale.com/' },
		],
		local: [
			{ name: 'Postgres', href: 'https://www.postgresql.org/' },
			{ name: 'MySQL', href: 'https://www.mysql.com/' },
		],
		note: 'Any Postgres or MySQL connection string, as in your Wrangler config.',
	},
};

export type ServiceMapping = {
	cloudflare: string;
	openorange: string;
	status: ServiceStatus;
	detail: string;
	/** Key into PROVIDERS. */
	providers?: string;
};

export const SERVICE_MAP: ServiceMapping[] = [
	{
		cloudflare: 'Workers',
		openorange: 'OpenOrange runtime',
		status: 'drop-in',
		detail: 'The Workers API surface (fetch handler, env bindings, waitUntil, Cache) on Node.js. Your code and wrangler config load unchanged.',
	},
	{
		cloudflare: 'Durable Objects',
		openorange: 'Rivet Actors',
		status: 'partial',
		detail: 'One Rivet Actor per object, with SQLite storage and alarms. Same class, same bindings. WebSocket hibernation is emulated: the object leaves memory, and its actor keeps running.',
	},
	{
		cloudflare: 'Workers KV',
		openorange: 'Actor-backed KV',
		status: 'drop-in',
		detail: 'The KV binding API, one Actor per namespace. Strongly consistent instead of eventually.',
	},
	{
		cloudflare: 'Queues',
		openorange: 'Actor-backed queues',
		status: 'drop-in',
		detail: 'Producers and consumers keep the Queues API, with batching, retries and dead-letter queues. One batch runs at a time per queue.',
	},
	{
		cloudflare: 'Workflows',
		openorange: "Cloudflare's own Workflows engine",
		status: 'partial',
		detail: "The engine that wrangler dev runs, copied from @cloudflare/workflows-shared, with one Rivet Actor per instance. Steps, sleeps, events and retries work. instance.subscribe() is not available.",
	},
	{
		cloudflare: 'Cron Triggers',
		openorange: 'Actor schedules',
		status: 'drop-in',
		detail: 'Same cron syntax in your config. Crons fire in orange dev too.',
	},
	{
		cloudflare: 'D1',
		openorange: 'SQLite on Rivet',
		status: 'drop-in',
		detail: 'The D1 binding API on one SQLite database in a Rivet Actor.',
	},
	{
		cloudflare: 'R2',
		openorange: 'A Rivet Actor, or your S3-compatible store',
		status: 'pluggable',
		detail: 'A bucket is an Actor by default. Point it at any S3-compatible store instead.',
		providers: 'r2',
	},
	{
		cloudflare: 'Workers AI',
		openorange: 'An OpenAI-compatible provider',
		status: 'pluggable',
		detail: 'The AI binding calls any OpenAI-compatible endpoint you already pay for. Text and embedding models.',
		providers: 'workers-ai',
	},
	{
		cloudflare: 'Sandboxes',
		openorange: 'Your sandbox provider',
		status: 'pluggable',
		detail: 'The Sandbox SDK runs on a hosted provider, an agentOS VM or a local directory. Other Container images are not run.',
		providers: 'sandboxes',
	},
	{
		cloudflare: 'Hyperdrive',
		openorange: 'Direct connection',
		status: 'drop-in',
		detail: 'Works unchanged. You are already in the VPC, so env.HYPERDRIVE passes the connection string straight through.',
		providers: 'hyperdrive',
	},
	{
		cloudflare: 'Browser Run',
		openorange: 'Your browser',
		status: 'pluggable',
		detail: '@cloudflare/puppeteer drives your Chrome or a hosted browser over the DevTools Protocol.',
		providers: 'browser-rendering',
	},
	{
		cloudflare: 'Email',
		openorange: 'Your SMTP server',
		status: 'pluggable',
		detail: 'send_email sends through your SMTP server. Inbound mail reaches email() from your provider\'s webhook.',
		providers: 'send-email',
	},
	{
		cloudflare: 'Vectorize, Images, Pipelines',
		openorange: 'Bring your own',
		status: 'planned',
		detail: 'The bindings load and every call throws. Call a replacement such as pgvector with fetch() today.',
	},
];

export const STATUS_LABEL: Record<ServiceStatus, string> = {
	'drop-in': 'Drop-in',
	pluggable: 'Pluggable',
	partial: 'Partial',
	planned: 'Not supported',
};

// Getting started, as in the repository's README quickstart.
export const GET_STARTED = [
	{
		title: 'Install',
		body: 'Install the `orange` CLI globally, then run it in your Worker project. Your code and your Wrangler configuration do not change.',
		commands: ['pnpm add -g open-orange'],
		output: null,
	},
	{
		title: 'Run your Worker',
		body: 'Reads your Wrangler configuration. Each Durable Object runs as a Rivet Actor with its own SQLite database.',
		commands: ['orange dev'],
		output: { status: 'ready', detail: 'http://127.0.0.1:8787' },
	},
	{
		title: 'Deploy',
		body: 'Builds an image of your Worker and rolls it out to your own cloud (AWS, GCP, Azure) or on-prem servers. Or use Rivet Cloud: fully managed, on a dedicated cluster in the provider and region you choose.',
		commands: ['orange login', 'orange link --cluster <name>', 'orange deploy'],
		output: { status: 'live', detail: 'https://api.example.com' },
	},
] as const;

export const AGENT_PROMPT =
	"Run this project's Cloudflare Worker on Rivet with OpenOrange. First, ask me where it should run: on my machine, on a Rivet cluster, or on my own Rivet Engine. Then read https://github.com/rivet-dev/open-orange/blob/main/README.md and follow its quickstart. Do not change my app code.";

// The bindings documented in docs/modules/, in the order the overview lists them.
export const MODULES = [
	{ label: 'Fetch handler', doc: 'fetch-events' },
	{ label: 'Durable Objects', doc: 'durable-objects' },
	{ label: 'KV', doc: 'kv' },
	{ label: 'D1', doc: 'd1' },
	{ label: 'R2', doc: 'r2' },
	{ label: 'Queues', doc: 'queues' },
	{ label: 'Workflows', doc: 'workflows' },
	{ label: 'Cron Triggers', doc: 'cron-triggers' },
	{ label: 'Static Assets', doc: 'assets' },
	{ label: 'Cache API', doc: 'cache' },
	{ label: 'Service bindings', doc: 'multi-worker' },
	{ label: 'Hyperdrive', doc: 'hyperdrive' },
	{ label: 'Workers AI', doc: 'workers-ai' },
	{ label: 'Browser Rendering', doc: 'browser-rendering' },
	{ label: 'Email', doc: 'email' },
	{ label: 'Rate Limiting', doc: 'rate-limiting' },
	{ label: 'Secrets Store', doc: 'secrets-store' },
	{ label: 'Tail Workers', doc: 'tail-workers' },
	{ label: 'Version Metadata', doc: 'version-metadata' },
	{ label: 'Worker Loader', doc: 'worker-loader' },
	{ label: 'Sandbox', doc: 'sandbox' },
	{ label: 'Runtime globals', doc: 'globals' },
] as const;
export const MODULES_NOT_BUILT = ['Vectorize', 'Images', 'Pipelines', 'mTLS certificates'] as const;

export type DeployTarget = {
	id: string;
	label: string;
	tagline: string;
	runsOn: string;
	operatedBy: string;
};

export const DEPLOY_TARGETS: DeployTarget[] = [
	{
		id: 'rivet-cloud',
		label: 'Rivet Cloud',
		tagline: 'Fully managed',
		runsOn: 'A dedicated cluster in the provider and region you choose',
		operatedBy: 'Rivet',
	},
	{
		id: 'byoc',
		label: 'BYOC',
		tagline: 'Your cloud, our ops',
		runsOn: 'Your AWS, Google Cloud or Azure account',
		operatedBy: 'Rivet, over an outbound connection',
	},
	{
		id: 'self-host',
		label: 'Self-hosted',
		tagline: 'Open source, Apache 2.0',
		runsOn: 'Any cloud, Hetzner or on-prem',
		operatedBy: 'You',
	},
];

// Wrangler commands and their orange equivalents, from the repository docs.
export const DX_COMMANDS = [
	{ wrangler: 'wrangler dev', orange: 'orange dev' },
	{ wrangler: 'wrangler deploy -e staging', orange: 'orange deploy -e staging' },
	{ wrangler: 'wrangler deploy --dry-run', orange: 'orange deploy --dry-run' },
] as const;

export const FAQ = [
	{
		q: "Wait, wasn't Cloudflare supposed to be cheaper?",
		a: 'For small, spiky Workers, it often is: the free tier and per-request pricing are hard to beat. The meters add up once Durable Objects stay busy. Duration is billed per GB-second while an object is active, and every SQLite row written costs $1 per million. The same GB-hours on Graviton EC2 cost about a fifth as much, and writes cost a fraction of that.',
	},
	{
		q: 'Is OpenOrange a fork of Cloudflare?',
		a: 'No. OpenOrange implements the Workers API on Node.js and maps each Cloudflare service onto Rivet. It uses Wrangler to read your configuration, and it reuses some MIT-licensed Cloudflare code, such as the Workflows engine. It does not run workerd.',
	},
	{
		q: 'Do I need to learn Rivet?',
		a: 'No. Rivet is the control plane underneath. You use the orange CLI and your Wrangler configuration.',
	},
	{
		q: 'What does it cost?',
		a: 'OpenOrange is Apache 2.0 and free. Self-host Rivet and your cloud bill is the only bill. Rivet Cloud and BYOC pricing is at rivet.dev/pricing.',
	},
	{
		q: 'What happens to the data already in KV, Durable Objects and R2?',
		a: 'orange migrate moves Durable Objects while your app serves, with no downtime. D1 databases are interrupted for a few minutes while they copy, because Cloudflare doesn\'t provide a way to migrate D1 live. R2 is S3-compatible, so rclone or aws s3 sync moves buckets.',
	},
	{
		q: 'Does it run at the edge?',
		a: 'It runs wherever you deploy it, in as many regions as you want. Most backends talk to one database; running next to it is faster than running at the edge. For stateless Worker requests, this works fine today. For Durable Objects, an upcoming Rivet update adds multi-region support, including edge regions.',
	},
	{
		q: 'Who maintains OpenOrange?',
		a: 'Rivet. OpenOrange is not affiliated with or endorsed by Cloudflare, Inc.',
	},
] as const;

export const CREDITS = [
	{ cloud: 'AWS Activate', amount: 200_000, note: 'Portfolio tier, pre-Series B with an Activate Provider', href: 'https://aws.amazon.com/startups/credits/' },
	{ cloud: 'Google for Startups Cloud Program', amount: 350_000, note: '$200k, or up to $350k for AI-first startups, Seed to Series A', href: 'https://cloud.google.com/startup' },
	{ cloud: 'Microsoft for Startups', amount: 150_000, note: 'Founders Hub, investor-referred tier', href: 'https://www.microsoft.com/en-us/startups' },
] as const;

export const CREDITS_TOTAL = CREDITS.reduce((sum, c) => sum + c.amount, 0);

// ---------------------------------------------------------------------------
// /vs-workerd/ — workerd (self-hosted) versus OpenOrange.
//
// Every workerd claim was read from the cloudflare/workerd source at the
// commit below, mostly src/workerd/server/workerd.capnp (the config schema)
// and src/workerd/server/factory/worker-factory.c++ (the limit enforcers).
// Re-check against a newer commit before changing `verified`.

export const WORKERD = {
	repo: 'https://github.com/cloudflare/workerd',
	commit: 'eed7c378dc9741360d77df360040e0a4a755afee',
	commitShort: 'eed7c37',
	verified: '2026-10-31',
	schema: 'https://github.com/cloudflare/workerd/blob/eed7c378dc9741360d77df360040e0a4a755afee/src/workerd/server/workerd.capnp',
	limits: 'https://github.com/cloudflare/workerd/blob/eed7c378dc9741360d77df360040e0a4a755afee/src/workerd/server/factory/worker-factory.c++#L276',
	readme: 'https://github.com/cloudflare/workerd#readme',
} as const;

export type WorkerdStatus = 'supported' | 'partial' | 'shim' | 'none';

export const WORKERD_STATUS_LABEL: Record<WorkerdStatus, string> = {
	supported: 'Supported',
	partial: 'Partial',
	shim: 'Shim only',
	none: 'Not included',
};

export type WorkerdServiceRow = {
	service: string;
	workerd: { status: WorkerdStatus; detail: string; source?: string };
	openorange: { status: ServiceStatus; detail: string };
};

// "Shim only" means workerd ships the JavaScript binding, which converts
// calls into HTTP requests to a service you name in the config. The thing
// that answers those requests is not in the binary. In wrangler dev that is
// Miniflare's simulator; in production it is yours to write.
export const WORKERD_SERVICES: WorkerdServiceRow[] = [
	{
		service: 'Workers',
		workerd: { status: 'supported', detail: 'The production V8 runtime.', source: `${WORKERD.schema}#L369-L434` },
		openorange: { status: 'drop-in', detail: 'Node.js.' },
	},
	{
		service: 'Durable Objects',
		workerd: {
			status: 'partial',
			detail: 'SQLite on local disk, marked experimental. One process owns every object. Cluster mode is behind --experimental and sends peer traffic unencrypted.',
			source: `${WORKERD.schema}#L852-L882`,
		},
		openorange: { status: 'partial', detail: 'Rivet Actors, spread across your instances. WebSocket hibernation is emulated.' },
	},
	{
		service: 'Workers KV',
		workerd: { status: 'shim', detail: 'Calls are forwarded to a service you write.', source: `${WORKERD.schema}#L524-L527` },
		openorange: { status: 'drop-in', detail: 'One Actor per namespace, strongly consistent.' },
	},
	{
		service: 'Queues',
		workerd: { status: 'shim', detail: 'No broker, retries or dead-letter. The consumer handler needs an experimental flag.', source: `${WORKERD.schema}#L538-L541` },
		openorange: { status: 'drop-in', detail: 'Batching, retries, dead-letter. One batch at a time per queue.' },
	},
	{
		service: 'Workflows',
		workerd: { status: 'shim', detail: 'The engine is in Miniflare, not workerd.', source: `${WORKERD.schema}#L336-L367` },
		openorange: { status: 'partial', detail: "Cloudflare's own engine, one Rivet Actor per instance." },
	},
	{
		service: 'Cron Triggers',
		workerd: { status: 'none', detail: 'The handler exists. Nothing fires it.' },
		openorange: { status: 'drop-in', detail: 'Same cron syntax.' },
	},
	{
		service: 'D1',
		workerd: { status: 'shim', detail: 'No d1 binding in the schema. The client wraps a fetcher you provide.' },
		openorange: { status: 'drop-in', detail: "One Actor's SQLite per database." },
	},
	{
		service: 'R2',
		workerd: { status: 'shim', detail: 'Calls are forwarded to a service you write.', source: `${WORKERD.schema}#L529-L531` },
		openorange: { status: 'pluggable', detail: 'Actor storage, or any S3-compatible store: S3, GCS, R2 or MinIO.' },
	},
	{
		service: 'Cache API',
		workerd: { status: 'none', detail: 'Throws "No Cache was configured" unless you supply an HTTP cache.', source: `${WORKERD.schema}#L736-L737` },
		openorange: { status: 'partial', detail: 'One Rivet Actor per cache name. Vary is ignored.' },
	},
	{
		service: 'Hyperdrive',
		workerd: { status: 'partial', detail: 'Passes straight to Postgres. No pooling.' },
		openorange: { status: 'drop-in', detail: 'Passes the connection string through.' },
	},
	{
		service: 'Workers AI, Vectorize, Browser Rendering',
		workerd: { status: 'none', detail: 'Shims only. wrangler dev proxies them to Cloudflare.' },
		openorange: { status: 'pluggable', detail: 'AI and Browser Rendering use your provider. Vectorize is not supported.' },
	},
	{
		service: 'Email Workers',
		workerd: { status: 'partial', detail: 'Handler type only. No ingress, no send_email.' },
		openorange: { status: 'pluggable', detail: 'Send and receive email through your SMTP server.' },
	},
	{
		service: 'Static assets',
		workerd: { status: 'partial', detail: 'A disk service with no Content-Type, _headers or _redirects.', source: `${WORKERD.schema}#L1056-L1065` },
		openorange: { status: 'partial', detail: "Serves the assets directory with Wrangler's rules. _headers and _redirects are not applied." },
	},
	{
		service: 'Service bindings, WebSockets, Wasm',
		workerd: { status: 'supported', detail: '' },
		openorange: { status: 'partial', detail: 'connect() and WebSocket upgrades to another Worker throw. Wasm module bindings are not supported.' },
	},
	{
		service: 'wrangler config',
		workerd: { status: 'partial', detail: 'name, main, compat flags, vars, durable_objects and migrations. Anything else is an error.', source: WORKERD.readme },
		openorange: { status: 'drop-in', detail: 'Read unchanged. A few keys, such as legacy_assets, stop orange dev.' },
	},
];

export type ThreeWayRow = {
	label: string;
	cloudflare: string;
	workerd: string;
	openorange: string;
	source?: string;
};

export const WORKERD_LIMITS: ThreeWayRow[] = [
	{
		label: 'Memory per Worker',
		cloudflare: '128 MB',
		workerd: 'No limit',
		openorange: 'The Node.js heap of the runtime process',
		source: WORKERD.limits,
	},
	{
		label: 'CPU time per request',
		cloudflare: '30 s default, 5 min max',
		workerd: 'No limit',
		openorange: 'No limit',
	},
	{
		label: 'Subrequests per request',
		cloudflare: '10,000',
		workerd: 'No limit',
		openorange: 'OS limits',
	},
	{
		label: 'Alarm wall time',
		cloudflare: '15 min',
		workerd: '15 min, hard-coded',
		openorange: 'About 24.8 days, the longest Node.js timer',
	},
	{
		label: 'Node.js APIs',
		cloudflare: 'nodejs_compat subset',
		workerd: 'nodejs_compat subset',
		openorange: 'Node.js modules, with workerd-shaped process and fs',
	},
	{
		label: 'Native npm modules',
		cloudflare: 'No',
		workerd: 'No',
		openorange: 'Not tested',
	},
	{
		label: 'Process model',
		cloudflare: "Cloudflare's",
		workerd: 'One thread per process. You run the load balancer.',
		openorange: 'One process per Worker per instance. Rivet places Actors across instances.',
	},
	{
		label: 'Durable Objects across machines',
		cloudflare: 'Yes',
		workerd: 'Experimental cluster mode, unencrypted.',
		openorange: 'Yes',
	},
	{
		label: 'Running untrusted code',
		cloudflare: 'Hardened',
		workerd: '"Not a hardened sandbox"',
		openorange: 'Same as any Node.js service',
	},
	{
		label: 'Runtime upgrades',
		cloudflare: "Cloudflare's schedule",
		workerd: 'Your schedule',
		openorange: 'Your schedule',
	},
];

export type ReceiptLine = { item: string; amount: string };
export type Receipt = { id: string; title: string; lines: ReceiptLine[]; total: string; note?: string };

// The cost section as three receipts for the same month: Cloudflare's own
// pricing example 3 (100 always-on Durable Objects) and the one VM that
// holds them.
export const WORKERD_RECEIPTS: Receipt[] = [
	{
		id: 'cloudflare',
		title: 'Cloudflare',
		lines: [
			{ item: 'Durable Object duration', amount: '412.50' },
			{ item: 'Durable Object requests', amount: '1.80' },
			{ item: 'Workers Paid minimum', amount: '5.00' },
		],
		total: '419.30',
		note: "Cloudflare's pricing example 3",
	},
	{
		id: 'workerd',
		title: 'workerd',
		lines: [
			{ item: 'm7i.xlarge, 730 h', amount: '147.00' },
			{ item: 'KV store', amount: 'you build it' },
			{ item: 'Queue broker', amount: 'you build it' },
			{ item: 'SQLite service', amount: 'you build it' },
			{ item: 'HTTP cache', amount: 'you build it' },
			{ item: 'Scheduler', amount: 'you build it' },
			{ item: 'Load balancer', amount: 'you build it' },
			{ item: 'Deploy pipeline', amount: 'you build it' },
		],
		total: '147.00 + ?',
	},
	{
		id: 'openorange',
		title: 'OpenOrange',
		lines: [
			{ item: 'm7i.xlarge, 730 h', amount: '147.00' },
			{ item: 'Rivet, Apache 2.0', amount: '0.00' },
		],
		total: '147.00',
		note: 'AWS on-demand, us-east-1',
	},
];

export const WORKERD_PICK = [
	{
		title: 'Pick workerd when',
		items: [
			'Your Worker is a fetch handler with no stateful bindings.',
			'You need the exact V8 semantics Cloudflare runs.',
			'You are building a dev tool.',
		],
	},
	{
		title: 'Pick OpenOrange when',
		items: [
			'You use KV, Queues, D1, Workflows, cron or the Cache API.',
			'Durable Objects need more than one machine.',
			'You want to deploy with one command.',
		],
	},
] as const;
