import type {
	InventoryDeclaration,
	InventoryMember,
} from "../generators/api-inventory.js";

type DurableObjectDecision = "excluded" | "included";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInventoryMember(value: unknown): value is InventoryMember {
	return (
		isRecord(value) &&
		typeof value.kind === "string" &&
		typeof value.name === "string" &&
		(value.optional === undefined || value.optional === true) &&
		(value.static === undefined || value.static === true)
	);
}

function isInventoryDeclaration(value: unknown): value is InventoryDeclaration {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		(value.namespacePath === undefined ||
			(Array.isArray(value.namespacePath) &&
				value.namespacePath.every((entry) => typeof entry === "string"))) &&
		(value.members === undefined ||
			(Array.isArray(value.members) && value.members.every(isInventoryMember)))
	);
}

function isDurableObjectDeclaration(
	declaration: InventoryDeclaration,
): boolean {
	return (
		declaration.name.includes("DurableObject") ||
		declaration.name.startsWith("SqlStorage") ||
		declaration.name.startsWith("SyncKv") ||
		declaration.name === "AlarmInvocationInfo" ||
		declaration.name === "FacetStartupOptions"
	);
}

function declarationKey(declaration: InventoryDeclaration): string {
	const namespace = declaration.namespacePath?.join(".") ?? "";
	return `${namespace.length === 0 ? "global" : namespace}:${declaration.name}`;
}

function memberKey(member: InventoryMember): string {
	return `${member.static === true ? "static " : ""}${member.kind}:${member.name}${member.optional === true ? "?" : ""}`;
}

function decision(value: unknown): value is DurableObjectDecision {
	return value === "included" || value === "excluded";
}

export function checkDurableObjectMatrix(
	value: unknown,
	inventoryValue: unknown,
): string[] {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!isRecord(value.declarations)
	) {
		return [
			"durable-objects.json must contain version 1 and a declarations object",
		];
	}
	if (
		!isRecord(inventoryValue) ||
		!Array.isArray(inventoryValue.declarations) ||
		!inventoryValue.declarations.every(isInventoryDeclaration)
	) {
		return ["Cloudflare API inventory has invalid declarations"];
	}

	const errors: string[] = [];
	const declarations = inventoryValue.declarations.filter(
		isDurableObjectDeclaration,
	);
	const expectedKeys = new Set(declarations.map(declarationKey));
	for (const declaration of declarations) {
		const key = declarationKey(declaration);
		const entry = value.declarations[key];
		if (
			!isRecord(entry) ||
			!decision(entry.decision) ||
			!isRecord(entry.members)
		) {
			errors.push(
				`Durable Object matrix is missing a valid ${key} declaration`,
			);
			continue;
		}

		const expectedMembers = new Set((declaration.members ?? []).map(memberKey));
		for (const expectedMember of expectedMembers) {
			if (!decision(entry.members[expectedMember])) {
				errors.push(
					`Durable Object matrix does not classify ${key}.${expectedMember}`,
				);
			}
		}
		for (const configuredMember of Object.keys(entry.members)) {
			if (!expectedMembers.has(configuredMember)) {
				errors.push(
					`Durable Object matrix contains unknown member ${key}.${configuredMember}`,
				);
			}
		}
	}

	for (const configuredKey of Object.keys(value.declarations)) {
		if (!expectedKeys.has(configuredKey)) {
			errors.push(
				`Durable Object matrix contains unknown declaration ${configuredKey}`,
			);
		}
	}
	return errors;
}
