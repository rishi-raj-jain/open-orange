// The cloudflare:pipelines module. Orange has no Pipelines service to send
// batches, so a transformation entrypoint loads and its run() is never called.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/pipeline-transform.ts#L87-L100

import { WorkerEntrypoint } from "../cloudflare-workers/worker-entrypoint.js";

interface PipelineBatchMetadata {
	pipelineId: string;
	pipelineName: string;
}

type PipelineRecord = Record<string, unknown>;

export class PipelineTransformationEntrypoint<
	Env = unknown,
	I extends PipelineRecord = PipelineRecord,
	O extends PipelineRecord = PipelineRecord,
> extends WorkerEntrypoint<Env> {
	async run(_records: I[], _metadata: PipelineBatchMetadata): Promise<O[]> {
		throw new Error("should be implemented by parent");
	}
}
