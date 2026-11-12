// The cloudflare:vectorize module. These constants match workerd.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/vectorize.ts#L5-L46

export const KnownModel = {
	"openai/text-embedding-ada-002": "openai/text-embedding-ada-002",
	"cohere/embed-multilingual-v2.0": "cohere/embed-multilingual-v2.0",
	"@cf/baai/bge-small-en-v1.5": "@cf/baai/bge-small-en-v1.5",
	"@cf/baai/bge-base-en-v1.5": "@cf/baai/bge-base-en-v1.5",
	"@cf/baai/bge-large-en-v1.5": "@cf/baai/bge-large-en-v1.5",
} as const;

export const DistanceMetric = {
	EUCLIDEAN: "euclidean",
	COSINE: "cosine",
	DOT_PRODUCT: "dot-product",
} as const;

export const MetadataRetrievalLevel = {
	ALL: "all",
	INDEXED: "indexed",
	NONE: "none",
} as const;
