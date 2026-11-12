// Whether each binding's data can move from Cloudflare to OpenOrange, for the
// status summary at the top of every binding page (<BindingStatus>). One entry
// per slug in binding-docs.ts; the build fails when one is missing.
//
// Checked against `orange migrate` (src/commands/migrate.ts, which moves only
// SQLite-backed Durable Objects and D1 databases and lists every other binding
// that holds data as "Not moved") and docs/migrate.mdx. Change an entry in the
// same commit as the migration code or guide.
import { BINDING_DOCS } from './binding-docs';
import type { Tone } from './conformance';

export type MigrationKind = 'live' | 'downtime' | 'not-supported' | 'not-needed';

export const MIGRATION_LABEL: Record<MigrationKind, { label: string; tone: Tone; meaning: string }> = {
	live: { label: 'Live migration', tone: 'pass', meaning: 'Zero downtime: the app keeps serving while the data moves.' },
	downtime: { label: 'Migration with downtime', tone: 'warn', meaning: 'A supported path that needs a cutover or a maintenance window.' },
	'not-supported': { label: 'Not supported', tone: 'fail', meaning: 'The binding holds data on Cloudflare, and OpenOrange has no way to move it yet.' },
	'not-needed': { label: 'Not needed', tone: 'none', meaning: 'Stateless or external: there is nothing to move.' },
};

export interface Migration {
	kind: MigrationKind;
	/** One short line. Backticks become code. */
	detail: string;
	/** The migration guide, when there is a path. */
	href?: string;
}

const GUIDE = '/docs/migrate/';

const notMoved = (what: string): Migration => ({
	kind: 'not-supported',
	detail: `\`orange migrate\` does not move ${what}. Copy the data yourself.`,
});
const nothing = (detail: string): Migration => ({ kind: 'not-needed', detail });

export const MIGRATION: Record<string, Migration> = {
	workers: nothing('A Worker holds no data. Deploy its code to Orange.'),
	'durable-objects': {
		kind: 'live',
		detail: 'Each SQLite-backed object moves on its first request to Orange, and a backfill moves the rest. KV-backed classes (`new_classes`) cannot move.',
		href: GUIDE,
	},
	kv: notMoved('KV namespaces'),
	d1: {
		kind: 'downtime',
		detail: '`orange migrate d1` refuses writes during the move, and every query fails while Cloudflare exports the database. A 1 GB database froze writes for about 3 minutes.',
		href: `${GUIDE}#5-move-d1-databases`,
	},
	r2: {
		kind: 'not-supported',
		detail: '`orange migrate` does not copy buckets. To keep the data on Cloudflare, point the binding at the R2 bucket through its S3 API.',
	},
	queues: notMoved('messages waiting on a Cloudflare queue'),
	workflows: notMoved('Workflow instances'),
	'cron-triggers': {
		kind: 'not-needed',
		detail: 'Schedules come from the Wrangler config. Run each cron in one place at a time during the move.',
		href: `${GUIDE}#cron-triggers`,
	},
	'rate-limiting': nothing('Counters start fresh in each window.'),
	'workers-ai': nothing('Models run on the provider you configure.'),
	'cache-api': nothing('A cache fills again on Orange.'),
	'durable-object-facets': {
		kind: 'not-supported',
		detail: 'Facets are not exported. Their parent object moves without them.',
		href: `${GUIDE}#what-does-not-move`,
	},
	'worker-loader': nothing('Dynamic Workers are code that the Worker loads at runtime.'),
	'service-bindings': nothing('A service binding holds no data.'),
	'dispatch-namespaces': {
		kind: 'not-supported',
		detail: '`orange migrate` does not move the user Workers of a dispatch namespace. Run each with another `-c` option.',
	},
	sandboxes: nothing('A sandbox starts fresh on its provider.'),
	containers: nothing('A container starts fresh, with nothing kept from Cloudflare.'),
	vectorize: notMoved('Vectorize indexes'),
	'browser-rendering': nothing('Sessions run on the browser you configure.'),
	images: {
		kind: 'not-supported',
		detail: 'The bindings are stubs. Images and videos stored on Cloudflare stay there.',
	},
	'send-email': nothing('Mail goes through your SMTP server.'),
	hyperdrive: nothing('The database stays where it is. Orange connects to it directly.'),
	pipelines: notMoved('Pipelines'),
	'ai-search': notMoved('AI Search instances'),
	'analytics-engine': notMoved('Analytics Engine datasets'),
	'mtls-certificates': {
		kind: 'not-supported',
		detail: 'The binding is a stub. Certificates uploaded to Cloudflare stay there.',
	},
	vpc: nothing('A VPC binding holds no data.'),
	'legacy-blobs': nothing('Blobs are files in the project.'),
};

for (const { slug } of BINDING_DOCS) {
	if (!MIGRATION[slug]) throw new Error(`binding-migration.ts: no migration entry for "${slug}"`);
}
