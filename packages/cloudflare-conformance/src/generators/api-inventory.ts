import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import ts from "typescript";

export interface InventoryMember {
	kind: string;
	name: string;
	optional?: true;
	static?: true;
	signatureHashes: string[];
}

export interface InventoryDeclaration {
	exported?: true;
	kind: string;
	members?: InventoryMember[];
	moduleSpecifier?: string;
	name: string;
	namespacePath?: string[];
	signatureHashes: string[];
}

export interface ApiInventory {
	schemaVersion: 1;
	source: {
		path: "cloudflare-runtime.d.ts";
		sha256: string;
		typescriptVersion: string;
	};
	moduleSpecifiers: string[];
	declarations: InventoryDeclaration[];
}

interface Scope {
	moduleSpecifier: string | null;
	namespacePath: string[];
}

interface MutableMember {
	kind: string;
	name: string;
	optional: boolean;
	static: boolean;
	signatureHashes: Set<string>;
}

interface MutableDeclaration {
	exported: boolean;
	kind: string;
	members: Map<string, MutableMember>;
	moduleSpecifier: string | null;
	name: string;
	namespacePath: string[];
	signatureHashes: Set<string>;
}

const printer = ts.createPrinter({
	newLine: ts.NewLineKind.LineFeed,
	removeComments: true,
});

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function signatureHash(node: ts.Node, sourceFile: ts.SourceFile): string {
	return sha256(
		printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).trimEnd(),
	);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
	);
}

function declarationKey(
	scope: Scope,
	kind: string,
	name: string,
	exported: boolean,
): string {
	return JSON.stringify([
		scope.moduleSpecifier,
		scope.namespacePath,
		kind,
		name,
		exported,
	]);
}

function memberKey(
	kind: string,
	name: string,
	optional: boolean,
	isStatic: boolean,
): string {
	return JSON.stringify([kind, name, optional, isStatic]);
}

function declarationName(name: ts.DeclarationName, sourceFile: ts.SourceFile): string {
	if (
		ts.isIdentifier(name) ||
		ts.isPrivateIdentifier(name) ||
		ts.isStringLiteral(name) ||
		ts.isNumericLiteral(name)
	) {
		return name.text;
	}

	return printer
		.printNode(ts.EmitHint.Unspecified, name, sourceFile)
		.trimEnd();
}

function memberKind(member: ts.TypeElement | ts.ClassElement | ts.EnumMember): string {
	if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
		return "property";
	}
	if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
		return "method";
	}
	if (ts.isGetAccessorDeclaration(member)) {
		return "getter";
	}
	if (ts.isSetAccessorDeclaration(member)) {
		return "setter";
	}
	if (ts.isConstructorDeclaration(member)) {
		return "constructor";
	}
	if (ts.isCallSignatureDeclaration(member)) {
		return "call-signature";
	}
	if (ts.isConstructSignatureDeclaration(member)) {
		return "construct-signature";
	}
	if (ts.isIndexSignatureDeclaration(member)) {
		return "index-signature";
	}
	if (ts.isEnumMember(member)) {
		return "enum-member";
	}

	return ts.SyntaxKind[member.kind] ?? `syntax-kind-${member.kind}`;
}

function memberName(
	member: ts.TypeElement | ts.ClassElement | ts.EnumMember,
	sourceFile: ts.SourceFile,
): string {
	if (ts.isConstructorDeclaration(member)) {
		return "constructor";
	}
	if (ts.isCallSignatureDeclaration(member)) {
		return "()";
	}
	if (ts.isConstructSignatureDeclaration(member)) {
		return "new()";
	}
	if (ts.isIndexSignatureDeclaration(member)) {
		return "[]";
	}
	if (member.name !== undefined) {
		return declarationName(member.name, sourceFile);
	}

	return ts.SyntaxKind[member.kind] ?? `syntax-kind-${member.kind}`;
}

function directMembers(
	node:
		| ts.ClassDeclaration
		| ts.InterfaceDeclaration
		| ts.TypeAliasDeclaration
		| ts.VariableDeclaration
		| ts.EnumDeclaration,
): readonly (ts.TypeElement | ts.ClassElement | ts.EnumMember)[] {
	if (
		ts.isClassDeclaration(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isEnumDeclaration(node)
	) {
		return node.members;
	}
	if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
		return node.type.members;
	}
	if (
		ts.isVariableDeclaration(node) &&
		node.type !== undefined &&
		ts.isTypeLiteralNode(node.type)
	) {
		return node.type.members;
	}

	return [];
}

export function createApiInventory(source: string): ApiInventory {
	const sourceFile = ts.createSourceFile(
		"cloudflare-runtime.d.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const modules = new Set<string>();
	const declarations = new Map<string, MutableDeclaration>();

	function addDeclaration(
		node: ts.Node,
		scope: Scope,
		kind: string,
		name: string,
		exported: boolean,
		members: readonly (ts.TypeElement | ts.ClassElement | ts.EnumMember)[] = [],
	): void {
		const key = declarationKey(scope, kind, name, exported);
		let declaration = declarations.get(key);
		if (declaration === undefined) {
			declaration = {
				exported,
				kind,
				members: new Map(),
				moduleSpecifier: scope.moduleSpecifier,
				name,
				namespacePath: [...scope.namespacePath],
				signatureHashes: new Set(),
			};
			declarations.set(key, declaration);
		}
		declaration.signatureHashes.add(signatureHash(node, sourceFile));

		for (const member of members) {
			const kind = memberKind(member);
			const name = memberName(member, sourceFile);
			const optional = "questionToken" in member && member.questionToken !== undefined;
			const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
			const key = memberKey(kind, name, optional, isStatic);
			let inventoryMember = declaration.members.get(key);
			if (inventoryMember === undefined) {
				inventoryMember = {
					kind,
					name,
					optional,
					static: isStatic,
					signatureHashes: new Set(),
				};
				declaration.members.set(key, inventoryMember);
			}
			inventoryMember.signatureHashes.add(signatureHash(member, sourceFile));
		}
	}

	function visitStatements(statements: ts.NodeArray<ts.Statement>, scope: Scope): void {
		for (const statement of statements) {
			const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);

			if (ts.isModuleDeclaration(statement)) {
				if (ts.isStringLiteral(statement.name)) {
					modules.add(statement.name.text);
					visitModuleBody(statement.body, {
						moduleSpecifier: statement.name.text,
						namespacePath: [],
					});
				} else if (
					(statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0
				) {
					visitModuleBody(statement.body, scope);
				} else {
					const name = statement.name.text;
					addDeclaration(statement, scope, "namespace", name, exported);
					visitModuleBody(statement.body, {
						...scope,
						namespacePath: [...scope.namespacePath, name],
					});
				}
				continue;
			}

			if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
				addDeclaration(
					statement,
					scope,
					"class",
					statement.name.text,
					exported,
					directMembers(statement),
				);
				continue;
			}
			if (ts.isInterfaceDeclaration(statement)) {
				addDeclaration(
					statement,
					scope,
					"interface",
					statement.name.text,
					exported,
					directMembers(statement),
				);
				continue;
			}
			if (ts.isTypeAliasDeclaration(statement)) {
				addDeclaration(
					statement,
					scope,
					"type-alias",
					statement.name.text,
					exported,
					directMembers(statement),
				);
				continue;
			}
			if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
				addDeclaration(
					statement,
					scope,
					"function",
					statement.name.text,
					exported,
				);
				continue;
			}
			if (ts.isEnumDeclaration(statement)) {
				addDeclaration(
					statement,
					scope,
					"enum",
					statement.name.text,
					exported,
					directMembers(statement),
				);
				continue;
			}
			if (ts.isVariableStatement(statement)) {
				const declarationKind =
					(statement.declarationList.flags & ts.NodeFlags.Const) !== 0
						? "const"
						: (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
							? "let"
							: "var";
				for (const declaration of statement.declarationList.declarations) {
					addDeclaration(
						declaration,
						scope,
						declarationKind,
						declarationName(declaration.name, sourceFile),
						exported,
						directMembers(declaration),
					);
				}
				continue;
			}
			if (ts.isExportAssignment(statement)) {
				addDeclaration(
					statement,
					scope,
					"export-assignment",
					statement.isExportEquals ? "export=" : "default",
					true,
				);
				continue;
			}
			if (ts.isExportDeclaration(statement)) {
				if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
					for (const element of statement.exportClause.elements) {
						addDeclaration(element, scope, "export", element.name.text, true);
					}
				} else {
					addDeclaration(statement, scope, "export", "*", true);
				}
			}
		}
	}

	function visitModuleBody(body: ts.ModuleBody | undefined, scope: Scope): void {
		if (body === undefined) {
			return;
		}
		if (ts.isModuleBlock(body)) {
			visitStatements(body.statements, scope);
			return;
		}
		if (!ts.isModuleDeclaration(body)) {
			return;
		}

		const name = body.name.text;
		addDeclaration(body, scope, "namespace", name, false);
		visitModuleBody(body.body, {
			...scope,
			namespacePath: [...scope.namespacePath, name],
		});
	}

	visitStatements(sourceFile.statements, {
		moduleSpecifier: null,
		namespacePath: [],
	});

	const inventoryDeclarations = [...declarations.values()]
		.map<InventoryDeclaration>((declaration) => {
			const members = [...declaration.members.values()]
				.map<InventoryMember>((member) => ({
					kind: member.kind,
					name: member.name,
					...(member.optional ? { optional: true as const } : {}),
					...(member.static ? { static: true as const } : {}),
					signatureHashes: [...member.signatureHashes].sort(),
				}))
				.sort((left, right) =>
					JSON.stringify(left).localeCompare(JSON.stringify(right)),
				);

			return {
				...(declaration.exported ? { exported: true as const } : {}),
				kind: declaration.kind,
				...(members.length > 0 ? { members } : {}),
				...(declaration.moduleSpecifier === null
					? {}
					: { moduleSpecifier: declaration.moduleSpecifier }),
				name: declaration.name,
				...(declaration.namespacePath.length > 0
					? { namespacePath: declaration.namespacePath }
					: {}),
				signatureHashes: [...declaration.signatureHashes].sort(),
			};
		})
		.sort((left, right) =>
			JSON.stringify(left).localeCompare(JSON.stringify(right)),
		);

	return {
		schemaVersion: 1,
		source: {
			path: "cloudflare-runtime.d.ts",
			sha256: sha256(source),
			typescriptVersion: ts.version,
		},
		moduleSpecifiers: [...modules].sort(),
		declarations: inventoryDeclarations,
	};
}

export async function writeApiInventory(
	declarationsPath: string,
	outputPath: string,
): Promise<ApiInventory> {
	const source = await readFile(declarationsPath, "utf8");
	const inventory = createApiInventory(source);
	await writeFile(outputPath, `${JSON.stringify(inventory, null, "\t")}\n`, "utf8");
	return inventory;
}
