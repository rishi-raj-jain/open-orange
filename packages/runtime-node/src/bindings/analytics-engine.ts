// Orange has no Analytics Engine to write to, so a dataset accepts data points
// and drops them, as Miniflare does in local development.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/analytics-engine/analytics-engine.worker.ts
export class AnalyticsEngineDataset {
	writeDataPoint(_event?: object): void {}
}
