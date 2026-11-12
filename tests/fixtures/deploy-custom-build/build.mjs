// A custom build: the Worker's entry file does not exist until this runs.
import { mkdirSync, writeFileSync } from "node:fs";

if (process.env.FAIL_THE_BUILD === "1") process.exit(3);
mkdirSync("generated", { recursive: true });
writeFileSync("generated/worker.js", 'export default { fetch() { return new Response("from a custom build"); } };\n');
