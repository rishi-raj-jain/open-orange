import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Product-level status of a Cloudflare product on Orange.
 * - `drop-in`: unchanged code and config run on an Orange backend. Differences are documented edge cases.
 * - `pluggable`: unchanged code runs, and the user picks the backend.
 * - `partial`: runs, but documented APIs throw or behave differently in ways common code hits.
 * - `stub`: the Worker loads, and every call on the binding throws a clear error.
 * - `unsupported`: nothing runs. Config that needs it stops `orange dev`.
 */
export const productStatuses = [
	"drop-in",
	"pluggable",
	"partial",
	"stub",
	"unsupported",
] as const;
export type ProductStatus = (typeof productStatuses)[number];

export interface ProductEntry {
	product: string;
	/** What Orange runs the product on. */
	orange: string;
	status: ProductStatus;
	note: string;
	/** Repository-relative files that back the status. */
	evidence: string[];
	/** Environment variables that pick or tune the backend. Required for `pluggable`. */
	configure?: ProductSetting[];
}

export interface ProductSetting {
	/** Variable name, or `NAME=value` for a fixed value. */
	variable: string;
	purpose: string;
}

export interface ProductTable {
	schemaVersion: 1;
	products: ProductEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/** Parses `compat/products.json` and lists every problem. Evidence must name files in the repository. */
export function validateProductTable(
	value: unknown,
	repositoryRoot: string,
): { table: ProductTable; problems: string[] } {
	if (!isRecord(value) || value.schemaVersion !== 1) {
		return {
			table: { schemaVersion: 1, products: [] },
			problems: ["products must be an object with schemaVersion 1"],
		};
	}
	const problems: string[] = [];
	const products = Array.isArray(value.products) ? value.products : [];
	if (products.length === 0) problems.push("products has no entries");
	const seen = new Set<string>();
	for (const [index, entry] of products.entries()) {
		const where = isRecord(entry) && nonEmptyString(entry.product) ? entry.product : `#${index}`;
		if (!isRecord(entry)) {
			problems.push(`${where}: not an object`);
			continue;
		}
		for (const field of ["product", "orange", "note"] as const) {
			if (!nonEmptyString(entry[field])) {
				problems.push(`${where}: ${field} must be a non-empty string`);
			}
		}
		if (nonEmptyString(entry.product)) {
			if (seen.has(entry.product)) problems.push(`${where}: duplicate product`);
			seen.add(entry.product);
		}
		if (!(productStatuses as readonly unknown[]).includes(entry.status)) {
			problems.push(
				`${where}: unknown status ${String(entry.status)} (expected one of ${productStatuses.join(", ")})`,
			);
		}
		if (entry.configure !== undefined || entry.status === "pluggable") {
			const configure = Array.isArray(entry.configure) ? entry.configure : [];
			if (configure.length === 0) {
				problems.push(`${where}: configure must list the variables that pick the backend`);
			}
			for (const setting of configure) {
				if (!isRecord(setting) || !nonEmptyString(setting.variable) || !nonEmptyString(setting.purpose)) {
					problems.push(`${where}: configure entries need a variable and a purpose`);
				}
			}
		}
		const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
		if (evidence.length === 0) problems.push(`${where}: evidence is empty`);
		for (const path of evidence) {
			if (!nonEmptyString(path)) {
				problems.push(`${where}: evidence must be file paths`);
			} else if (!existsSync(join(repositoryRoot, path))) {
				problems.push(`${where}: evidence names missing file ${path}`);
			}
		}
	}
	return { table: value as unknown as ProductTable, problems };
}

export async function readProductTable(
	path: string,
	repositoryRoot: string,
): Promise<ProductTable> {
	const { table, problems } = validateProductTable(
		JSON.parse(await readFile(path, "utf8")),
		repositoryRoot,
	);
	if (problems.length > 0) {
		throw new Error(`${path} is invalid:\n  ${problems.join("\n  ")}`);
	}
	return table;
}
