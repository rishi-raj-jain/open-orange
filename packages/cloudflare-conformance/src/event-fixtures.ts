import { join } from "node:path";

const fetchEventDirectory = join(
	import.meta.dirname,
	"../fixtures/events/fetch",
);

export const fetchEventFixturePath = join(fetchEventDirectory, "worker.ts");
export const invalidFetchEventFixturePath = join(
	fetchEventDirectory,
	"worker.invalid.ts",
);
