// Saves Cloudflare's own exports of seed.sql in exports/, frozen the way `orange migrate d1` freezes
// a database, so the tests' fake export API serves real dumps.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... tsx tests/fixtures/migrate-d1-export/capture.ts [name]
//
// It creates a D1 database and a Worker named `name` (default `orange-d1-capture-<random>`), deploys
// this fixture prepared by `orange migrate prepare`, seeds it, freezes it through the prepared Worker,
// exports it in both formats, and deletes the Worker and the database again.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const here = import.meta.dirname;
const root = join(here, "..", "..", "..");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
if (accountId === "" || apiToken === "") throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
const name = process.argv[2] ?? `orange-d1-capture-${randomBytes(3).toString("hex")}`;
const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

async function call(path: string, init: { body?: unknown; method?: string } = {}): Promise<any> {
	const response = await fetch(`${api}${path}`, {
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
		method: init.method ?? "GET",
	});
	const body: any = await response.json();
	if (!body.success) throw new Error(`${path}: ${JSON.stringify(body.errors)}`);
	return body.result;
}

function run(command: string, args: string[], cwd: string, input?: string): string {
	return execFileSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, input, stdio: ["pipe", "pipe", "pipe"] });
}

async function exportDump(databaseId: string, compatibility: "d1" | "sqlite3_cli_only"): Promise<Buffer> {
	let bookmark: string | undefined;
	for (;;) {
		const result = await call(`/d1/database/${databaseId}/export`, {
			body: { dump_options: { compatibility }, output_format: "polling", ...(bookmark === undefined ? {} : { current_bookmark: bookmark }) },
			method: "POST",
		});
		bookmark = result.at_bookmark;
		if (result.status === "error") throw new Error(result.error);
		if (result.status === "complete") return Buffer.from(await (await fetch(result.result.signed_url)).arrayBuffer());
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
}

const project = await mkdtemp(join(tmpdir(), "orange-d1-capture-"));
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const database = await call("/d1/database", { body: { name }, method: "POST" });
try {
	await cp(here, project, { recursive: true });
	const config = JSON.parse(await readFile(join(project, "wrangler.jsonc"), "utf8"));
	await writeFile(
		join(project, "wrangler.jsonc"),
		JSON.stringify({ ...config, d1_databases: [{ ...config.d1_databases[0], database_id: database.uuid, database_name: name }], name, workers_dev: true }),
	);
	run(process.execPath, ["--import", "tsx", join(root, "src", "bin.ts"), "migrate", "prepare", "--config", join(project, "wrangler.jsonc")], root);
	const token = randomUUID();
	run(process.execPath, [wrangler, "deploy", "--config", "wrangler.migrate.jsonc"], project);
	run(process.execPath, [wrangler, "secret", "put", "WORKER_MIGRATOR_TOKEN", "--config", "wrangler.migrate.jsonc"], project, token);
	run(process.execPath, [wrangler, "d1", "execute", name, "--remote", "--yes", "--file", "seed.sql", "--config", "wrangler.migrate.jsonc"], project);
	const subdomain = (await call("/workers/subdomain")).subdomain;
	const worker = `https://${name}.${subdomain}.workers.dev`;
	const route = async (op: string, body: unknown): Promise<any> => {
		for (let attempt = 0; ; attempt += 1) {
			const response = await fetch(`${worker}/__migrate-d1/DB/${op}`, { body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` }, method: "POST" });
			if (response.ok) return response.json();
			// A new workers.dev route and secret take a few seconds to reach every location.
			if (attempt === 30) throw new Error(`${op}: ${response.status} ${await response.text()}`);
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	};
	const frozen = await route("freeze", { leaseSeconds: 600 });
	await writeFile(join(here, "exports", "sqlite3_cli_only.sql.gz"), gzipSync(await exportDump(database.uuid, "sqlite3_cli_only")));
	await writeFile(join(here, "exports", "d1.sql.gz"), gzipSync(await exportDump(database.uuid, "d1")));
	await route("unfreeze", { freeze: frozen.freeze });
} finally {
	try {
		run(process.execPath, [wrangler, "delete", "--force", "--config", "wrangler.migrate.jsonc"], project);
	} catch (error: unknown) {
		console.error(`Delete the Worker ${name} by hand: ${String(error)}`);
	}
	await call(`/d1/database/${database.uuid}`, { method: "DELETE" });
	await rm(project, { force: true, recursive: true });
}
