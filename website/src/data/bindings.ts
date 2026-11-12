// One record per Cloudflare product for the bindings page: the product row
// from products.json, the written docs, the matrix entries, the truth-table
// claim and the scaling row that belong to it. The joins are by id and name,
// so a product with no claim or no matrix rows simply has none.
import { BINDING_DOCS, type BindingDoc } from './binding-docs';
import { docRoute } from '../components/docs/routes';
import {
	CLAIMS_BY_ID,
	MATRIX,
	PRODUCTS,
	TRUTH,
	type Claim,
	type MatrixEntry,
	type Product,
	type ScaleRow,
} from './conformance';

export interface Binding {
	product: Product;
	doc: BindingDoc;
	slug: string;
	matrix: MatrixEntry[];
	claims: Claim[];
	scaling?: ScaleRow;
}

/** Matrix entry id prefixes (or exact ids) per product slug. */
const MATRIX_IDS: Record<string, string[]> = {
	workers: ['handler-fetch-object', 'handler-fetch-class', 'handler-named-entrypoints', 'binding-vars-plain-text', 'binding-vars-json', 'dev-vars-secrets', 'binding-dotenv-secrets', 'binding-assets', 'binding-importable-env', 'ctx-exports'],
	'durable-objects': ['binding-durable-object-namespace', 'binding-durable-object-namespace-cross-script', 'handler-do-'],
	kv: ['binding-kv'],
	d1: ['binding-d1'],
	r2: ['binding-r2'],
	queues: ['binding-queues-producer', 'handler-queue'],
	workflows: ['binding-workflows'],
	'cron-triggers': ['handler-scheduled'],
	'rate-limiting': ['binding-rate-limiting'],
	'workers-ai': ['binding-workers-ai'],
	'cache-api': [],
	'durable-object-facets': ['do-ctx-facets'],
	'worker-loader': ['binding-worker-loader'],
	'service-bindings': ['service-binding-self', 'binding-service-named-entrypoint', 'binding-service-props', 'binding-service-fetch', 'binding-service-rpc', 'service-binding-connect', 'service-binding-cross-worker'],
	'dispatch-namespaces': ['binding-dispatch-namespace'],
	sandboxes: [],
	containers: ['do-ctx-container'],
	vectorize: ['binding-vectorize'],
	'browser-rendering': ['binding-browser-rendering'],
	images: ['binding-images', 'binding-stream', 'binding-media'],
	'send-email': ['binding-send-email', 'handler-email'],
	hyperdrive: ['binding-hyperdrive'],
	pipelines: ['binding-pipelines'],
	'ai-search': ['binding-ai-search-namespace', 'binding-ai-search'],
	'analytics-engine': ['binding-analytics-engine'],
	'mtls-certificates': ['binding-mtls-certificate'],
	vpc: ['binding-vpc-service', 'binding-vpc-network'],
	'legacy-blobs': ['binding-wasm-module', 'binding-text-blob', 'binding-data-blob'],
};

/** Truth-table claim ids per product slug. */
const CLAIM_IDS: Record<string, string[]> = {
	'durable-objects': ['do-storage', 'do-kv-backed', 'do-ids-gates', 'do-alarms', 'do-alarm-overdue', 'do-rpc', 'do-websockets', 'websocket-hibernation'],
	kv: ['binding-kv'],
	d1: ['binding-d1'],
	r2: ['binding-r2'],
	queues: ['binding-queues'],
	workflows: ['binding-workflows'],
	'cron-triggers': ['binding-cron'],
	'rate-limiting': ['binding-rate-limiting'],
	'workers-ai': ['binding-ai'],
	'cache-api': ['binding-cache'],
	'durable-object-facets': ['do-facets'],
	'service-bindings': ['binding-services', 'binding-services-connect', 'binding-services-events'],
	'dispatch-namespaces': ['binding-services'],
	sandboxes: ['binding-sandbox'],
	containers: ['binding-containers'],
	vectorize: ['binding-stubs'],
	'browser-rendering': ['binding-browser'],
	images: ['binding-stubs'],
	'send-email': ['binding-send-email', 'binding-email'],
	pipelines: ['binding-stubs'],
	'mtls-certificates': ['binding-stubs'],
};

/** Scaling-table `binding` name per product slug. */
const SCALING_NAME: Record<string, string> = {
	workers: 'Workers',
	'durable-objects': 'Durable Objects',
	workflows: 'Workflows',
	d1: 'D1',
	kv: 'KV',
	queues: 'Queues',
	'rate-limiting': 'Rate Limiting',
	'cache-api': 'Cache',
	r2: 'R2',
};

const matrixFor = (slug: string): MatrixEntry[] => {
	const ids = MATRIX_IDS[slug] ?? [];
	return MATRIX.filter((e) => ids.some((id) => (id.endsWith('-') ? e.id.startsWith(id) : e.id === id || e.id.startsWith(`${id}-`))));
};

export const BINDINGS: Binding[] = PRODUCTS.map((product) => {
	const doc = BINDING_DOCS.find((d) => d.product === product.product);
	if (!doc) throw new Error(`No binding doc for product "${product.product}"`);
	const claims = (CLAIM_IDS[doc.slug] ?? []).map((id) => {
		const c = CLAIMS_BY_ID.get(id);
		if (!c) throw new Error(`No truth-table claim "${id}" for ${doc.slug}`);
		return c;
	});
	return {
		product,
		doc,
		slug: doc.slug,
		matrix: matrixFor(doc.slug),
		claims,
		scaling: TRUTH.scaling.find((s) => s.binding === SCALING_NAME[doc.slug]),
	};
});

/** For a truth-table claim id, the bindings-page section it belongs to. */
export const BINDING_SLUG_BY_CLAIM: Record<string, string> = {};
for (const [slug, ids] of Object.entries(CLAIM_IDS)) {
	for (const id of ids) if (id.startsWith('binding-')) BINDING_SLUG_BY_CLAIM[id] ??= slug;
}

/** For a matrix entry id, the bindings-page section it belongs to. */
export const BINDING_SLUG_BY_MATRIX: Map<string, string> = new Map(BINDINGS.flatMap((b) => b.matrix.map((e) => [e.id, b.slug] as [string, string])));

/**
 * The docs page that shows a binding's details: the page of its first doc
 * file. Stubs documented only in docs/modules/bindings.mdx have none; the
 * Status page lists them.
 */
export function bindingPage(b: Binding): string | undefined {
	const id = b.doc.docs[0]?.replace(/^docs\//, '').replace(/\.mdx$/, '');
	if (!id || (id === 'modules/bindings' && b.product.status === 'stub')) return undefined;
	return docRoute(id);
}

/** The bindings whose details belong on the docs page with this collection id. */
export const bindingsForDoc = (id: string): Binding[] => BINDINGS.filter((b) => bindingPage(b) === docRoute(id));
