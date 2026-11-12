import { createHash } from "node:crypto";

import type {
	ApiInventory,
	InventoryDeclaration,
} from "../generators/api-inventory.js";
import type { WranglerHelpInventory } from "../generators/wrangler-help.js";

const runtimeCategories = ["globals", "modules", "bindings", "events"] as const;
const statuses = new Set(["partial", "implemented"]);
const sha256Pattern = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportUnknownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
	errors: string[],
): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) {
			errors.push(`${path} has unknown field ${JSON.stringify(key)}`);
		}
	}
}

function validateStatus(
	value: unknown,
	path: string,
	errors: string[],
): boolean {
	if (typeof value !== "string" || !statuses.has(value)) {
		errors.push(`${path}.status must be "partial" or "implemented"`);
		return false;
	}
	return true;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function matchesDeclaration(
	declaration: InventoryDeclaration,
	reference: Record<string, unknown>,
): boolean {
	const namespacePath = reference.namespacePath ?? [];
	return (
		declaration.name === reference.name &&
		declaration.kind === reference.kind &&
		declaration.moduleSpecifier === reference.moduleSpecifier &&
		Boolean(declaration.exported) === Boolean(reference.exported) &&
		Array.isArray(namespacePath) &&
		sameStrings(declaration.namespacePath ?? [], namespacePath)
	);
}

function referenceLabel(reference: Record<string, unknown>): string {
	const modulePrefix =
		typeof reference.moduleSpecifier === "string"
			? `${reference.moduleSpecifier}:`
			: "global:";
	const namespace = Array.isArray(reference.namespacePath)
		? `${reference.namespacePath.join(".")}.`
		: "";
	return `${modulePrefix}${namespace}${String(reference.kind)}/${String(reference.name)}`;
}

function validateDeclarationReference(
	value: unknown,
	path: string,
	inventory: ApiInventory,
	errors: string[],
): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	reportUnknownKeys(
		value,
		[
			"exported",
			"kind",
			"moduleSpecifier",
			"name",
			"namespacePath",
			"signatureHashes",
		],
		path,
		errors,
	);

	if (typeof value.name !== "string" || value.name.length === 0) {
		errors.push(`${path}.name must be a non-empty string`);
	}
	if (typeof value.kind !== "string" || value.kind.length === 0) {
		errors.push(`${path}.kind must be a non-empty string`);
	}
	if (
		value.moduleSpecifier !== undefined &&
		(typeof value.moduleSpecifier !== "string" || value.moduleSpecifier.length === 0)
	) {
		errors.push(`${path}.moduleSpecifier must be a non-empty string when present`);
	}
	if (value.exported !== undefined && typeof value.exported !== "boolean") {
		errors.push(`${path}.exported must be a boolean when present`);
	}
	if (
		value.namespacePath !== undefined &&
		(!Array.isArray(value.namespacePath) ||
			!value.namespacePath.every(
				(segment) => typeof segment === "string" && segment.length > 0,
			))
	) {
		errors.push(`${path}.namespacePath must be an array of non-empty strings`);
	}
	if (
		!Array.isArray(value.signatureHashes) ||
		value.signatureHashes.length === 0 ||
		!value.signatureHashes.every(
			(hash) => typeof hash === "string" && sha256Pattern.test(hash),
		)
	) {
		errors.push(`${path}.signatureHashes must contain SHA-256 hashes`);
		return;
	}

	const hashes = [...value.signatureHashes];
	const canonicalHashes = [...new Set(hashes)].sort();
	if (!sameStrings(hashes, canonicalHashes)) {
		errors.push(`${path}.signatureHashes must be unique and sorted`);
	}

	if (
		typeof value.name !== "string" ||
		typeof value.kind !== "string" ||
		(value.moduleSpecifier !== undefined &&
			typeof value.moduleSpecifier !== "string") ||
		(value.exported !== undefined && typeof value.exported !== "boolean") ||
		(value.namespacePath !== undefined && !Array.isArray(value.namespacePath))
	) {
		return;
	}

	const matches = inventory.declarations.filter((declaration) =>
		matchesDeclaration(declaration, value),
	);
	if (matches.length === 0) {
		errors.push(`${path} references removed API ${referenceLabel(value)}`);
		return;
	}
	if (matches.length > 1) {
		errors.push(`${path} ambiguously references API ${referenceLabel(value)}`);
		return;
	}
	const match = matches[0];
	if (match !== undefined && !sameStrings(match.signatureHashes, hashes)) {
		errors.push(`${path} has changed signatures for ${referenceLabel(value)}`);
	}
}

// A partial global may list the Cloudflare members it does not provide. The
// generated type check leaves only those members out of its assignability
// check, and fails if Orange's type has any of them. A member typed as the
// global itself, such as self.self, gets the same partial check.
function validateAbsentMembers(
	claim: Record<string, unknown>,
	path: string,
	errors: string[],
): void {
	const members = claim.absentMembers;
	if (members === undefined) return;
	if (claim.status !== "partial") {
		errors.push(`${path}.absentMembers is only allowed on a partial claim`);
	}
	if (
		!Array.isArray(members) ||
		members.length === 0 ||
		!members.every((member) => typeof member === "string" && /^[$A-Z_a-z][$\w]*$/.test(member))
	) {
		errors.push(`${path}.absentMembers must be a non-empty array of member names`);
	}
}

function validateRuntimeCategory(
	value: unknown,
	path: string,
	inventory: ApiInventory,
	errors: string[],
): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}

	for (const [name, claim] of Object.entries(value)) {
		const claimPath = `${path}.${name}`;
		if (name.length === 0) {
			errors.push(`${path} cannot contain an empty claim name`);
		}
		if (!isRecord(claim)) {
			errors.push(`${claimPath} must be an object`);
			continue;
		}
		reportUnknownKeys(
			claim,
			path === "support.json.globals"
				? ["absentMembers", "declarations", "status"]
				: ["declarations", "status"],
			claimPath,
			errors,
		);
		validateStatus(claim.status, claimPath, errors);
		validateAbsentMembers(claim, claimPath, errors);
		if (!Array.isArray(claim.declarations) || claim.declarations.length === 0) {
			errors.push(`${claimPath}.declarations must be a non-empty array`);
			continue;
		}
		for (const [index, reference] of claim.declarations.entries()) {
			validateDeclarationReference(
				reference,
				`${claimPath}.declarations[${index}]`,
				inventory,
				errors,
			);
		}
	}
}

function validateCommands(
	value: unknown,
	helpInventory: WranglerHelpInventory,
	errors: string[],
): void {
	if (!isRecord(value)) {
		errors.push("support.json.commands must be an object");
		return;
	}

	for (const [path, claim] of Object.entries(value)) {
		const claimPath = `support.json.commands.${path}`;
		if (!isRecord(claim)) {
			errors.push(`${claimPath} must be an object`);
			continue;
		}
		reportUnknownKeys(claim, ["helpHash", "status"], claimPath, errors);
		validateStatus(claim.status, claimPath, errors);
		if (typeof claim.helpHash !== "string" || !sha256Pattern.test(claim.helpHash)) {
			errors.push(`${claimPath}.helpHash must be a SHA-256 hash`);
			continue;
		}

		const command = helpInventory.commands.find(
			(candidate) => candidate.path.join(" ") === path,
		);
		if (command === undefined) {
			errors.push(`${claimPath} references removed command ${JSON.stringify(path)}`);
		} else if (sha256(command.help) !== claim.helpHash) {
			errors.push(`${claimPath} has changed help for ${JSON.stringify(path)}`);
		}
	}
}

export function validateSupport(
	value: unknown,
	inventory: ApiInventory,
	helpInventory: WranglerHelpInventory,
): string[] {
	const errors: string[] = [];
	if (!isRecord(value)) {
		return ["support.json must contain an object"];
	}
	reportUnknownKeys(
		value,
		["bindings", "commands", "events", "globals", "modules", "version"],
		"support.json",
		errors,
	);
	if (value.version !== 1) {
		errors.push("support.json.version must equal 1");
	}
	validateCommands(value.commands, helpInventory, errors);
	for (const category of runtimeCategories) {
		validateRuntimeCategory(
			value[category],
			`support.json.${category}`,
			inventory,
			errors,
		);
	}
	return errors;
}

export function claimedGlobalStatuses(value: unknown): Map<string, string> {
	const statuses = new Map<string, string>();
	if (!isRecord(value) || !isRecord(value.globals)) {
		return statuses;
	}
	for (const [name, claim] of Object.entries(value.globals)) {
		if (
			isRecord(claim) &&
			(claim.status === "partial" || claim.status === "implemented")
		) {
			statuses.set(name, claim.status);
		}
	}
	return statuses;
}
