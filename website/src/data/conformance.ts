// Conformance data, read at build time straight from packages/cloudflare-conformance
// in this repository, so every build shows the latest recorded run. This module
// adds the types and the few derived views the compatibility and bindings pages
// need. Nothing here is written by hand except the labels; every number comes
// from a recorded run.
import latestJson from '../../../packages/cloudflare-conformance/results/latest.json';
import historyJson from '../../../packages/cloudflare-conformance/results/history.json';
import truthTableJson from '../../../packages/cloudflare-conformance/compat/truth-table.json';
import matrixJson from '../../../packages/cloudflare-conformance/compat/matrix.json';
import productsJson from '../../../packages/cloudflare-conformance/compat/products.json';
import templatesJson from '../../../packages/cloudflare-conformance/compat/real-projects.json';

/** Every saved run, keyed by its path under results/, as history.json records it. */
const runFiles = import.meta.glob('../../../packages/cloudflare-conformance/results/runs/*.json', { eager: true, import: 'default' });

const REPO = 'rivet-dev/open-orange';
const PACKAGE = 'packages/cloudflare-conformance';

/* ---------- Types (mirrors packages/cloudflare-conformance/src) ---------- */

export type ClaimStatus = 'works' | 'partial' | 'does-not-work' | 'not-run';
export type EvidenceOutcome = 'pass' | 'fail' | 'partial' | 'needs-secrets' | 'not-run';
export type ProjectStatus = 'works' | 'works-emulated' | 'partial' | 'fails' | 'needs-secrets' | 'not-run';

export type Evidence =
	| { kind: 'test'; test: string }
	| { kind: 'test-file'; file: string }
	| { kind: 'area'; area: string }
	| { kind: 'probe'; probe: string; step: string }
	| { kind: 'project'; project: string; step: string }
	| { kind: 'example'; example: string }
	| { kind: 'repro'; repro: string; step: string };

export interface EvidenceResult {
	source: Evidence;
	label: string;
	orange: EvidenceOutcome;
	counts?: { pass: number; total: number };
	workerd?: string;
	error?: string;
}

export interface Claim {
	id: string;
	title: string;
	cloudflare?: string;
	orange: string;
	why?: string;
	action?: string;
	availability?: 'coming-soon';
	drawbacks?: string[];
	status: ClaimStatus;
	evidence: EvidenceResult[];
}

export interface Area {
	id: string;
	title: string;
	summary: string;
	claims: Claim[];
}

export interface ScaleRow {
	binding: string;
	scalesBy: string;
	detail: string;
	status: ClaimStatus;
	evidence: EvidenceResult[];
}

export interface ProjectFailure {
	step: string;
	kind: string;
	error: string;
	owner?: string;
	ownerLabel: string;
	note?: string;
	reference?: string;
	/** The same step rerun with emulated hibernation. Never changes the step's status. */
	emulated?: 'pass' | 'fail';
}

export interface CloudStep {
	name: string;
	kind: string;
	status: 'pass' | 'fail' | 'not-applicable' | 'needs-secrets';
	note?: string;
	error?: string;
	secrets?: string[];
}

/** One project deployed to Rivet Cloud, apart from the local runs. */
export interface CloudProject {
	project: string;
	repo: string;
	commit: string;
	directory: string;
	what: string;
	ran: string;
	shortfalls: string[];
	ranAt: string;
	plan: string;
	deployedWith: string;
	steps: CloudStep[];
	counts: { pass: number; fail: number; notApplicable: number; needsSecrets: number };
}

export interface ProjectRow {
	id: string;
	repo: string;
	url: string;
	commit: string;
	stars: number;
	origin: string;
	directory: string;
	status: ProjectStatus;
	steps: { pass: number; total: number };
	changes: { kind: string; what: string; why: string }[];
	failures: ProjectFailure[];
	secrets: string[];
	error?: string | null;
	durableObjects: { classes: string[]; file: string; uses: string[] };
	ranAt: string;
	orange: string;
	rivetkit: string;
}

export interface TruthTable {
	schemaVersion: 1;
	sources: {
		conformance: { date: string; orange: string; rivetkit: string; pass: number; total: number };
		probes: { orange: string; rivetkit: string; ranAt: string };
		realProjects: { orange: string[]; rivetkit: string[]; ranAt: string };
		examples: { orange: string; ranAt: string } | null;
	};
	summary: {
		claims: Record<ClaimStatus, number>;
		projects: Record<ProjectStatus, number>;
		unmodified: number;
		failedSteps: { owner: string; label: string; steps: number }[];
	};
	notices: Claim[];
	areas: Area[];
	beyond: Claim[];
	scaling: ScaleRow[];
	projects: ProjectRow[];
	excluded: { repo: string; stars: number; reason: string }[];
	emulatedHibernation: {
		note: string;
		steps: { pass: number; ran: number; total: number };
		projects: number;
		orange: string[];
		rivetkit: string[];
		ranAt: string;
	};
	cloud: { notes: string[]; projects: CloudProject[] };
}

export type MatrixStatus = 'supported' | 'partial' | 'alternative' | 'stub' | 'rejected' | 'unsupported' | 'not-applicable';

export type MatrixEvidence =
	| { kind: 'code'; path: string; lines?: string }
	| { kind: 'test'; file: string; test: string }
	| { kind: 'doc'; url: string }
	| { kind: 'note'; text?: string; note?: string };

export interface MatrixEntry {
	id: string;
	category: string;
	name: string;
	status: MatrixStatus;
	cloudflare: string;
	orange: string;
	notes?: string;
	workaround?: string;
	since?: string;
	unverified?: string;
	evidence: MatrixEvidence[];
}

export type ProductStatus = 'drop-in' | 'partial' | 'pluggable' | 'stub';

export interface Product {
	product: string;
	orange: string;
	status: ProductStatus;
	note?: string;
	evidence: string[];
}

/** One Cloudflare template run beside `wrangler dev` (compat/real-projects.json, recorded by hand). */
export type TemplateStatus = 'works' | 'partial' | 'fails' | 'needs-step';
export type TemplateMode = 'unchanged' | 'build' | 'probe';

export interface Template {
	project: string;
	url: string;
	flows: string;
	before: Record<TemplateMode, TemplateStatus>;
	after: Record<TemplateMode, TemplateStatus>;
	blocker?: string;
}

export interface TemplateTable {
	before: { date: string; orange: string };
	after: { date: string; orange: string };
	wrangler: string;
	projects: Template[];
}

export interface TestRow {
	file: string;
	area: string;
	test: string;
	status: string;
	cause: string | null;
	error?: string;
	node?: string;
	/** For a test cut as a Cloudflare quota: the quota, and whether OpenOrange passed it anyway. */
	quota?: string;
	outcome?: string;
}

export interface FileRow {
	id: string;
	area: string;
	synthetic: boolean;
	pass: number;
	total: number;
}

export interface PassTotal {
	pass: number;
	total: number;
}

export interface Summary {
	schemaVersion: number;
	date: string;
	startedAt: string;
	/** Commit time of the Orange commit, when the run recorded it. */
	committedAt?: string;
	wallSeconds?: number;
	label: string;
	note: string;
	orange: { sha: string; dirty: string | null };
	rivetkit: string;
	workerd: { tag: string; commit: string };
	totals: {
		files: number;
		syntheticFiles: number;
		/** Tests run with /tmp remapped to a scratch directory. Neither pass nor fail. */
		remapped?: PassTotal | null;
		all: { pass: number; total: number };
		upstream: { pass: number; total: number };
		synthetic: { pass: number; total: number };
		cloudflare: { pass: number; total: number };
		node: { pass: number; total: number };
		infraExcluded: number;
		/** Tests cut short by a Cloudflare quota in the reference run. Not counted. */
		cloudflareQuotaCut?: number;
		workerdOnly: number;
	};
	perArea: Record<string, { pass: number; total: number }>;
	perCause: Record<string, number>;
	notSupported: Record<string, string>;
}

/** One entry of results/history.json. Upstream tests only; `run` names its snapshot when one was saved. */
export interface HistoryPoint {
	source: 'run' | 'manual';
	date: string;
	sha: string | null;
	label: string | null;
	rivetkit: string | null;
	pass: number;
	total: number;
	perArea: Record<string, PassTotal> | null;
	/** Present (possibly null) from schema 2, which leaves workerd-only Node.js tests unscored. */
	node?: PassTotal | null;
	note?: string;
	run?: string;
}

export type RunSnapshot = Summary & { files: FileRow[]; tests: TestRow[] };

/* ---------- Data ---------- */

const latest = latestJson as unknown as RunSnapshot;
export const SUMMARY = latest as Summary;
export const TESTS = latest.tests;
export const HISTORY = historyJson as unknown as HistoryPoint[];
export const TEMPLATES = templatesJson as unknown as TemplateTable;
const RUNS = new Map(Object.entries(runFiles).map(([path, run]) => [path.slice(path.indexOf('runs/')), run as RunSnapshot]));
export const TRUTH = truthTableJson as unknown as TruthTable;
export const MATRIX = (matrixJson as unknown as { entries: MatrixEntry[] }).entries;
export const PRODUCTS = (productsJson as unknown as { products: Product[] }).products;

export const CONFORMANCE = {
	repoUrl: `https://github.com/${REPO}`,
	/** A file in the open-orange repository at the commit the latest run used. */
	fileUrl(path: string, lines?: string) {
		const anchor = lines ? `#L${lines.replace('-', '-L')}` : '';
		return `https://github.com/${REPO}/blob/${SUMMARY.orange.sha}/${path}${anchor}`;
	},
	packageUrl: `https://github.com/${REPO}/tree/${SUMMARY.orange.sha}/${PACKAGE}`,
	workerdUrl: `https://github.com/cloudflare/workerd/tree/${SUMMARY.workerd.tag}`,
} as const;

/* ---------- Labels ---------- */

/** Four outcomes, used for claims, evidence, projects and matrix rows alike. */
export type Tone = 'pass' | 'warn' | 'fail' | 'none';

/** Full class names per tone, written out so Tailwind can see them. */
export const TONE_CLASS: Record<Tone, { chip: string; dot: string; text: string; bar: string }> = {
	pass: { chip: 'tone-pass', dot: 'dot-pass', text: 'text-pass', bar: 'bg-pass' },
	warn: { chip: 'tone-warn', dot: 'dot-warn', text: 'text-warn', bar: 'bg-warn' },
	fail: { chip: 'tone-fail', dot: 'dot-fail', text: 'text-fail', bar: 'bg-fail' },
	none: { chip: 'tone-none', dot: 'dot-none', text: 'text-ink-faint', bar: 'bg-ink/20' },
};

export const CLAIM_LABEL: Record<ClaimStatus, { label: string; tone: Tone; meaning: string }> = {
	works: { label: 'Works', tone: 'pass', meaning: 'Every recorded result passed.' },
	partial: { label: 'Partial', tone: 'warn', meaning: 'Some recorded results passed and some did not.' },
	'does-not-work': { label: 'Does not work', tone: 'fail', meaning: 'No recorded result passed.' },
	'not-run': { label: 'Not run', tone: 'none', meaning: 'Nothing has been recorded yet.' },
};

export const OUTCOME_LABEL: Record<EvidenceOutcome, { label: string; tone: Tone }> = {
	pass: { label: 'Pass', tone: 'pass' },
	partial: { label: 'Partial', tone: 'warn' },
	fail: { label: 'Fail', tone: 'fail' },
	'needs-secrets': { label: 'Needs secrets', tone: 'none' },
	'not-run': { label: 'Not run', tone: 'none' },
};

export const PROJECT_LABEL: Record<ProjectStatus, { label: string; tone: Tone; meaning: string }> = {
	works: { label: 'Works', tone: 'pass', meaning: 'Every step passed.' },
	'works-emulated': { label: 'Works, emulated hibernation', tone: 'pass', meaning: 'The only failed steps need WebSocket hibernation, and each passes with emulated hibernation.' },
	partial: { label: 'Partial', tone: 'warn', meaning: 'Some steps failed. Each failure names its cause.' },
	fails: { label: 'Fails', tone: 'fail', meaning: 'The project did not run.' },
	'needs-secrets': { label: 'Needs secrets', tone: 'none', meaning: 'Runs up to the point that needs a credential we do not have.' },
	'not-run': { label: 'Not run', tone: 'none', meaning: 'Not recorded yet.' },
};

export const MATRIX_LABEL: Record<MatrixStatus, { label: string; tone: Tone; meaning: string }> = {
	supported: { label: 'Supported', tone: 'pass', meaning: 'OpenOrange implements the Cloudflare API.' },
	alternative: { label: 'Alternative', tone: 'pass', meaning: 'The same API, on an OpenOrange backend such as Rivet Actors.' },
	partial: { label: 'Partial', tone: 'warn', meaning: 'Works with a known difference. The row says which.' },
	stub: { label: 'Stub', tone: 'fail', meaning: 'The binding loads; every call throws an error that names it.' },
	rejected: { label: 'Rejected', tone: 'fail', meaning: 'Fails at config load or Worker load with a clear error.' },
	unsupported: { label: 'Unsupported', tone: 'fail', meaning: 'Missing, ignored, or wrong without a clear error.' },
	'not-applicable': { label: 'N/A', tone: 'none', meaning: 'Deploy-only, workerd-only, or experimental. Not scored.' },
};

export const PRODUCT_LABEL: Record<ProductStatus, { label: string; tone: Tone; meaning: string }> = {
	'drop-in': { label: 'Drop-in', tone: 'pass', meaning: 'Same API, same config. Nothing to change.' },
	partial: { label: 'Partial', tone: 'warn', meaning: 'Works with known differences, listed on its row.' },
	pluggable: { label: 'Pluggable', tone: 'pass', meaning: 'Works out of the box, and can point at a provider you choose.' },
	stub: { label: 'Stub', tone: 'fail', meaning: 'The binding loads; every call throws an error that names it.' },
};

export const TEMPLATE_LABEL: Record<TemplateStatus, { label: string; tone: Tone; meaning: string }> = {
	works: { label: 'Works', tone: 'pass', meaning: 'Every tested flow behaves as it does on `wrangler dev`.' },
	partial: { label: 'Partial', tone: 'warn', meaning: 'Starts; some flows break.' },
	fails: { label: 'Fails', tone: 'fail', meaning: 'Does not run.' },
	'needs-step': { label: 'Needs a step', tone: 'none', meaning: 'Needs a step this mode skips, so it does not start.' },
};

export const TEMPLATE_MODES: { id: TemplateMode; label: string; meaning: string }[] = [
	{ id: 'unchanged', label: 'Config unchanged', meaning: 'The Wrangler config as published, plus `d1 migrations apply`.' },
	{ id: 'build', label: '+ build step', meaning: 'Also runs the project’s own build, or puts `node_modules/.bin` on PATH.' },
	{ id: 'probe', label: '+ probe config', meaning: 'Also adds one config key, such as `assets.directory` for Vite-plugin projects.' },
];

export const MATRIX_CATEGORY_LABEL: Record<string, string> = {
	bindings: 'Bindings',
	handlers: 'Handlers',
	'durable-objects': 'Durable Objects',
	'durable-object-storage': 'Durable Object storage',
	sql: 'SQL',
	'runtime-apis': 'Runtime APIs',
	fetch: 'Fetch',
	'node-compat': 'Node.js compat',
	'compat-flags': 'Compatibility flags',
	config: 'Wrangler config',
	limits: 'Limits',
};

/* ---------- Derived views ---------- */

/** Escapes text for HTML and turns `backticks` into <code>. The data uses no other markup. */
export function inline(text: string): string {
	const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
}

export const percent = (pass: number, total: number) => (total === 0 ? 0 : Math.round((pass / total) * 1000) / 10);

export const fmt = (n: number) => n.toLocaleString('en-US');

const testIndex = new Map<string, TestRow>(TESTS.map((t) => [`${t.file}\u0000${t.test}`, t]));

/** The recorded outcome of a matrix test reference, or null when the run has no such test. */
export function lookupTest(file: string, test: string): TestRow | null {
	return testIndex.get(`${file}\u0000${test}`) ?? null;
}

/** Matrix categories in display order with their entries and status counts. */
export const MATRIX_CATEGORIES = Object.keys(MATRIX_CATEGORY_LABEL)
	.map((id) => {
		const entries = MATRIX.filter((e) => e.category === id);
		const counts = {} as Record<MatrixStatus, number>;
		for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
		return { id, label: MATRIX_CATEGORY_LABEL[id], entries, counts };
	})
	.filter((c) => c.entries.length > 0);

/** A test counts toward the score unless it is test infrastructure or fails on plain Node.js too (workerd-only). */
export const isScored = (t: TestRow) => t.status !== 'infra' && t.status !== 'quota' && t.node !== 'fail';

/** OpenOrange's own Durable Object tests, as opposed to workerd's suite. */
export const isSynthetic = (t: TestRow) => t.file.startsWith('synthetic--');

/** Every scored test grouped by area, largest first, in the run's file order. Counts come
 *  from the tests themselves, so Durable Objects includes OpenOrange's own tests here. */
export const TESTS_BY_AREA = [...new Set(TESTS.map((t) => t.area))]
	.map((area) => {
		const tests = TESTS.filter((t) => t.area === area && isScored(t));
		const pass = tests.filter((t) => t.status === 'pass').length;
		return { area, tests, pass, total: tests.length, percent: percent(pass, tests.length) };
	})
	.filter((a) => a.total > 0)
	.sort((a, b) => b.total - a.total);

/** The matrix row that cites a test, so a test can link into the matrix. First citation wins. */
const matrixByTest = new Map<string, MatrixEntry>();
for (const e of MATRIX) for (const ev of e.evidence) if (ev.kind === 'test') matrixByTest.set(`${ev.file}\u0000${ev.test}`, matrixByTest.get(`${ev.file}\u0000${ev.test}`) ?? e);
export const matrixRowFor = (t: TestRow): MatrixEntry | undefined => matrixByTest.get(`${t.file}\u0000${t.test}`);

/** Per-area scores, largest suite first, from the latest run. */
export const AREAS_SCORED = Object.entries(SUMMARY.perArea)
	.map(([area, counts]) => ({ area, ...counts, percent: percent(counts.pass, counts.total) }))
	.sort((a, b) => b.total - a.total);

/** Failure causes, most first. */
export const CAUSES = Object.entries(SUMMARY.perCause)
	.map(([cause, count]) => ({ cause, count }))
	.sort((a, b) => b.count - a.count);

export const CAUSE_MEANING: Record<string, string> = {
	'Behavior differs': 'The test ran and asserted something OpenOrange does differently.',
	'Not supported': 'The test needs an API or flag OpenOrange does not implement.',
	'Hangs (60s timeout)': 'The test did not finish in 60 seconds.',
	'File fails at load': 'The whole test file failed to load, so none of its tests ran.',
	'Not-implemented API': 'The test reached a method that throws not-implemented.',
	'Bundling fails': 'esbuild could not bundle the test Worker.',
	'Not run': 'The test was skipped by the runner.',
};

/** Every claim on the page, keyed by id, for cross-links from the bindings page. */
export const CLAIMS_BY_ID = new Map<string, Claim>([...TRUTH.notices, ...TRUTH.areas.flatMap((a) => a.claims), ...TRUTH.beyond].map((c) => [c.id, c]));

/** Matrix entry ids that belong to a product, by a loose name match on the Wrangler key or product name. */
export function matrixEntriesFor(ids: string[]): MatrixEntry[] {
	const set = new Set(ids);
	return MATRIX.filter((e) => set.has(e.id));
}

/* ---------- Run history ---------- */

/** "do-sql-test" for "synthetic--do-sql-test", "blob-test" for "api-tests--blob-test". */
export const shortFile = (id: string) => id.replace(/^\w+-tests--|^synthetic--/, '');

export const runName = (label: string | null, sha: string | null) => label ?? sha ?? 'unnamed run';

/** "Nov 10, 20:08" in UTC. */
export function utcTime(iso: string): string {
	const d = new Date(iso);
	const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
	return `${month} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const testKey = (t: Pick<TestRow, 'file' | 'test'>) => `${t.file}\u0000${t.test}`;
const runPath = (s: Pick<Summary, 'date' | 'orange'>) => `runs/${s.date}-${s.orange.sha}.json`;
const latestIndex = HISTORY.findIndex((e) => e.run === runPath(latest));
/** Every history entry before the latest run, oldest first. */
const earlier = HISTORY.slice(0, latestIndex === -1 ? HISTORY.length : latestIndex);
const NODE_AREA = 'Node.js compat';
/** From schema 2 on, workerd-only Node.js tests are left out, so Node.js counts only compare within one scoring. */
const sameScoring = (e: HistoryPoint) => (e.node !== undefined && e.node !== null) === (SUMMARY.schemaVersion !== 1);

/** The saved run before the latest one, with a snapshot to compare test by test. */
const previousEntry = [...earlier].reverse().find((e) => e.run !== undefined && RUNS.has(e.run));
const previous = previousEntry?.run ? RUNS.get(previousEntry.run) : undefined;

/** What changed test by test since the previous saved run. */
export const CHANGES = previous
	? (() => {
			const before = new Map(previous.tests.map((t) => [testKey(t), t]));
			const now = new Set(TESTS.map(testKey));
			return {
				since: { name: runName(previousEntry?.label ?? null, previous.orange.sha), sha: previous.orange.sha, date: previous.date },
				score: { before: previous.totals.all, now: SUMMARY.totals.all },
				newlyPassing: TESTS.filter((t) => {
					const b = before.get(testKey(t));
					return isScored(t) && t.status === 'pass' && b !== undefined && b.status !== 'pass';
				}),
				newlyFailing: TESTS.filter((t) => {
					const b = before.get(testKey(t));
					return isScored(t) && t.status !== 'pass' && b !== undefined && isScored(b) && b.status === 'pass';
				}),
				/** Scored on the previous run, not scored now: cut as a quota, or moved to workerd-only. */
				leftScore: TESTS.filter((t) => {
					const b = before.get(testKey(t));
					return !isScored(t) && b !== undefined && isScored(b);
				}),
				joinedScore: TESTS.filter((t) => {
					const b = before.get(testKey(t));
					return isScored(t) && (b === undefined || !isScored(b));
				}).length,
				removed: previous.tests.filter((t) => isScored(t) && !now.has(testKey(t))).length,
			};
		})()
	: null;

/** Upstream passes gained since the first run scored the same way as the latest. */
export const GAINED = (() => {
	const first = HISTORY.find(sameScoring);
	return first && first !== HISTORY[latestIndex]
		? { count: SUMMARY.totals.upstream.pass - first.pass, since: runName(first.label, first.sha), sha: first.sha }
		: null;
})();

/** Bands of the history chart, stacked from the bottom. A failure cause no band names counts as an error. */
export const HISTORY_BANDS = [
	{ id: 'pass', name: 'Pass', color: 'var(--color-pass)', causes: [] as string[] },
	{ id: 'remapped', name: 'Ran with /tmp remapped, not scored', color: 'var(--color-ink-soft)', causes: [] as string[] },
	{ id: 'differs', name: 'Behavior differs', color: 'var(--color-warn)', causes: ['Behavior differs'] },
	{ id: 'unsupported', name: 'Not supported', color: 'var(--color-ink-faint)', causes: ['Not supported', 'Unsupported binding', 'Not-implemented API', 'Missing CF globals'] },
	{ id: 'timeout', name: 'Timeout', color: '#d9776f', causes: ['Hangs (60s timeout)'] },
	{ id: 'error', name: 'Error', color: 'var(--color-fail)', causes: [] as string[] },
] as const;

function bandCounts(run: RunSnapshot): number[] {
	const remapped = run.totals.remapped ?? { pass: 0, total: 0 };
	const counts = HISTORY_BANDS.map(() => 0);
	counts[0] = run.totals.all.pass;
	counts[1] = remapped.total;
	for (const [cause, count] of Object.entries(run.perCause)) {
		const i = HISTORY_BANDS.findIndex((b) => (b.causes as readonly string[]).includes(cause));
		counts[i === -1 ? HISTORY_BANDS.length - 1 : i] += count;
	}
	return counts;
}

/** One point per saved run, in commit order (or start order when the commit time is unknown). */
export const HISTORY_RUNS = HISTORY.flatMap((e) => {
	const run = e.run ? RUNS.get(e.run) : undefined;
	if (!run) return [];
	const counts = bandCounts(run);
	const remapped = run.totals.remapped ?? { pass: 0, total: 0 };
	return [
		{
			name: runName(e.label, e.sha),
			sha: e.sha ?? run.orange.sha,
			at: run.committedAt ?? run.startedAt,
			committed: run.committedAt !== undefined,
			counts,
			total: counts.reduce((a, b) => a + b, 0),
			remapped,
		},
	];
}).sort((a, b) => a.at.localeCompare(b.at));

/** Each area's upstream score now, split by what passed on the first comparable run and what passed since. */
export const AREA_PROGRESS = (() => {
	const previousWithAreas = [...earlier].reverse().find((e) => e.perArea !== null);
	return Object.entries(SUMMARY.perArea)
		.map(([area, { pass, total }]) => {
			const first = earlier.find((e) => e.perArea?.[area] && (area !== NODE_AREA || sameScoring(e)));
			const firstPass = Math.min(first?.perArea?.[area]?.pass ?? 0, pass);
			const prev = previousWithAreas?.perArea?.[area];
			const prevPass = prev && (area !== NODE_AREA || sameScoring(previousWithAreas!)) ? prev.pass : undefined;
			return {
				area,
				pass,
				total,
				percent: percent(pass, total),
				first: first ? { pass: firstPass, sha: first.sha, date: first.date } : null,
				since: pass - firstPass,
				thisRun: prevPass === undefined ? 0 : pass - Math.min(Math.max(prevPass, firstPass), pass),
			};
		})
		.sort((a, b) => b.total - a.total);
})();

/** Every recorded run, newest first, with its upstream score. `remapped` tests count in the total, as on the old report. */
export const RUN_LIST = HISTORY.map((e, i) => {
	const run = e.run ? RUNS.get(e.run) : undefined;
	const remapped = run?.totals.remapped ?? { pass: 0, total: 0 };
	const total = e.total + remapped.total;
	return {
		name: runName(e.label, e.sha),
		sha: e.sha,
		date: e.date,
		rivetkit: e.rivetkit,
		manual: e.source === 'manual',
		latest: i === latestIndex,
		note: e.note,
		pass: e.pass,
		total,
		remapped,
		percent: percent(e.pass, total),
	};
}).reverse();

/* ---------- Durable Objects ---------- */

const doCounted = (t: TestRow) => t.status !== 'infra' && t.status !== 'quota';

/** OpenOrange's own Durable Object tests, ported from workerd's C++ tests, one row per file. */
export const SYNTHETIC_FILES = latest.files
	.filter((f) => f.synthetic)
	.map((f) => {
		const failing = TESTS.filter((t) => t.file === f.id && doCounted(t) && t.status === 'fail');
		const fresh = CHANGES?.newlyPassing.filter((t) => t.file === f.id).length ?? 0;
		return {
			file: shortFile(f.id),
			pass: f.pass,
			total: f.total,
			fresh,
			gaps: failing.filter((t) => matrixRowFor(t)),
			fails: failing.filter((t) => !matrixRowFor(t)),
		};
	});

/** Every Durable Object test, upstream and OpenOrange's own, that counts toward the score. */
const DO_TESTS = TESTS.filter((t) => t.area === 'Durable Objects' && doCounted(t));

/** The Durable Object tests that still fail, each with the matrix row that explains it when one cites it. */
export const DO_FAILING = {
	total: DO_TESTS.length,
	tests: DO_TESTS.filter((t) => t.status === 'fail').map((t) => ({ test: t, entry: matrixRowFor(t) })),
};

/* ---------- Cloudflare templates ---------- */

/** Per run mode: how many templates work and start now, and on the earlier recorded run. */
export const TEMPLATE_MODE_TOTALS = TEMPLATE_MODES.map((m) => {
	const count = (when: 'before' | 'after', ok: TemplateStatus[]) => TEMPLATES.projects.filter((p) => ok.includes(p[when][m.id])).length;
	return {
		...m,
		works: count('after', ['works']),
		worksBefore: count('before', ['works']),
		starts: count('after', ['works', 'partial']),
		startsBefore: count('before', ['works', 'partial']),
	};
});
