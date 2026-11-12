// One entry per product in the open-orange `compat/products.json`, in the same
// order: the slug the bindings pages use, the Wrangler keys that create the
// binding, and the docs page that documents it. Status, behaviour and test
// results come from the conformance data, not from here, so this file holds
// no prose that can go stale.

export interface BindingDoc {
	/** Must equal the `product` field in products.json exactly. */
	product: string;
	/** URL-safe slug, e.g. "kv", "durable-objects", "workers-ai". */
	slug: string;
	/** Wrangler config keys that create the binding, e.g. ["kv_namespaces"]. Empty if none (e.g. Workers). */
	wranglerKeys: string[];
	/** The docs file(s) for it; the first one is the page that shows its compatibility details. */
	docs: string[];
}

export const BINDING_DOCS: BindingDoc[] = [
	{ product: 'Workers', slug: 'workers', wranglerKeys: [], docs: ['docs/modules/fetch-events.mdx', 'docs/modules/globals.mdx'] },
	{ product: 'Durable Objects', slug: 'durable-objects', wranglerKeys: ['durable_objects', 'migrations'], docs: ['docs/modules/durable-objects.mdx', 'docs/modules/multi-worker.mdx'] },
	{ product: 'KV', slug: 'kv', wranglerKeys: ['kv_namespaces'], docs: ['docs/modules/kv.mdx'] },
	{ product: 'D1', slug: 'd1', wranglerKeys: ['d1_databases'], docs: ['docs/modules/d1.mdx'] },
	{ product: 'R2', slug: 'r2', wranglerKeys: ['r2_buckets'], docs: ['docs/modules/r2.mdx'] },
	{ product: 'Queues', slug: 'queues', wranglerKeys: ['queues.producers', 'queues.consumers'], docs: ['docs/modules/queues.mdx', 'docs/modules/multi-worker.mdx'] },
	{ product: 'Workflows', slug: 'workflows', wranglerKeys: ['workflows'], docs: ['docs/modules/workflows.mdx', 'docs/modules/multi-worker.mdx'] },
	{ product: 'Cron Triggers', slug: 'cron-triggers', wranglerKeys: ['triggers.crons'], docs: ['docs/modules/cron-triggers.mdx', 'docs/modules/multi-worker.mdx'] },
	{ product: 'Rate Limiting', slug: 'rate-limiting', wranglerKeys: ['ratelimits', 'unsafe.bindings'], docs: ['docs/modules/rate-limiting.mdx'] },
	{ product: 'Workers AI + AI Gateway', slug: 'workers-ai', wranglerKeys: ['ai'], docs: ['docs/modules/workers-ai.mdx'] },
	{ product: 'Cache API', slug: 'cache-api', wranglerKeys: [], docs: ['docs/modules/cache.mdx'] },
	{ product: 'Durable Object Facets', slug: 'durable-object-facets', wranglerKeys: [], docs: ['docs/modules/durable-objects.mdx'] },
	{ product: 'Worker Loader', slug: 'worker-loader', wranglerKeys: ['worker_loaders'], docs: ['docs/modules/worker-loader.mdx'] },
	{ product: 'Service bindings to other Workers', slug: 'service-bindings', wranglerKeys: ['services'], docs: ['docs/modules/multi-worker.mdx', 'docs/modules/bindings.mdx'] },
	{ product: 'Workers for Platforms (dispatch namespaces)', slug: 'dispatch-namespaces', wranglerKeys: ['dispatch_namespaces'], docs: ['docs/modules/multi-worker.mdx', 'docs/modules/bindings.mdx'] },
	{ product: 'Sandboxes', slug: 'sandboxes', wranglerKeys: ['containers', 'durable_objects', 'migrations'], docs: ['docs/modules/sandbox.mdx'] },
	{ product: 'Containers', slug: 'containers', wranglerKeys: ['containers'], docs: ['docs/modules/sandbox.mdx', 'docs/modules/bindings.mdx', 'docs/modules/durable-objects.mdx'] },
	{ product: 'Vectorize', slug: 'vectorize', wranglerKeys: ['vectorize'], docs: ['docs/modules/bindings.mdx'] },
	{ product: 'Browser Rendering', slug: 'browser-rendering', wranglerKeys: ['browser'], docs: ['docs/modules/browser-rendering.mdx'] },
	{ product: 'Images, Media, Stream', slug: 'images', wranglerKeys: ['images', 'media', 'stream'], docs: ['docs/modules/bindings.mdx'] },
	{ product: 'Send Email', slug: 'send-email', wranglerKeys: ['send_email'], docs: ['docs/modules/email.mdx'] },
	{ product: 'Hyperdrive', slug: 'hyperdrive', wranglerKeys: ['hyperdrive'], docs: ['docs/modules/hyperdrive.mdx'] },
	{ product: 'Pipelines', slug: 'pipelines', wranglerKeys: ['pipelines'], docs: ['docs/modules/bindings.mdx'] },
	{ product: 'AI Search', slug: 'ai-search', wranglerKeys: ['ai_search', 'ai_search_namespaces'], docs: ['docs/modules/bindings.mdx', 'docs/modules/workers-ai.mdx'] },
	{ product: 'Analytics Engine', slug: 'analytics-engine', wranglerKeys: ['analytics_engine_datasets'], docs: ['docs/modules/bindings.mdx'] },
	{ product: 'mTLS certificates', slug: 'mtls-certificates', wranglerKeys: ['mtls_certificates'], docs: ['docs/modules/bindings.mdx'] },
	{ product: 'VPC', slug: 'vpc', wranglerKeys: ['vpc_networks', 'vpc_services'], docs: ['docs/modules/bindings.mdx'] },
	{ product: 'Legacy blobs', slug: 'legacy-blobs', wranglerKeys: ['text_blobs', 'data_blobs', 'wasm_modules'], docs: ['docs/modules/bindings.mdx'] },
];
