import { readdir, readFile } from "node:fs/promises";
import { relative } from "node:path";

import ts from "typescript";

type UnsafeTypeEscape =
	| "any type"
	| "non-null assertion"
	| "type assertion"
	| "@ts-ignore"
	| "@ts-nocheck";

export interface TypeScriptSource {
	path: string;
	source: string;
}

function isConstAssertion(node: ts.AsExpression): boolean {
	return (
		ts.isTypeReferenceNode(node.type) &&
		ts.isIdentifier(node.type.typeName) &&
		node.type.typeName.text === "const"
	);
}

const safetyComment = /^\/\/ SAFETY:\s*\S/;

/**
 * A type assertion is allowed only when the contiguous `//` comment block
 * directly above its first line starts with a non-empty `// SAFETY:` reason.
 */
function hasSafetyComment(lines: readonly string[], castLine: number): boolean {
	let first = castLine;
	while (first > 0 && lines[first - 1]?.trimStart().startsWith("//")) {
		first -= 1;
	}
	if (first === castLine) {
		return false;
	}
	return safetyComment.test(lines[first]?.trimStart() ?? "");
}

function finding(
	file: TypeScriptSource,
	sourceFile: ts.SourceFile,
	position: number,
	kind: UnsafeTypeEscape,
): string {
	const location = sourceFile.getLineAndCharacterOfPosition(position);
	const reason =
		kind === "type assertion" ? " without a `// SAFETY:` comment directly above" : "";
	return `${file.path}:${location.line + 1}:${location.character + 1} uses unsafe ${kind}${reason}`;
}

export function findUnsafeTypeEscapes(file: TypeScriptSource): string[] {
	const sourceFile = ts.createSourceFile(
		file.path,
		file.source,
		ts.ScriptTarget.Latest,
		true,
		file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const errors: string[] = [];
	const lines = file.source.split("\n");
	const isJustifiedCast = (node: ts.Node): boolean =>
		hasSafetyComment(
			lines,
			sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line,
		);

	for (const match of file.source.matchAll(/@ts-(ignore|nocheck)\b/g)) {
		if (match.index === undefined) {
			continue;
		}
		errors.push(
			finding(
				file,
				sourceFile,
				match.index,
				match[1] === "ignore" ? "@ts-ignore" : "@ts-nocheck",
			),
		);
	}

	function visit(node: ts.Node): void {
		if (node.kind === ts.SyntaxKind.AnyKeyword) {
			errors.push(finding(file, sourceFile, node.getStart(sourceFile), "any type"));
		} else if (
			ts.isAsExpression(node) &&
			!isConstAssertion(node) &&
			!isJustifiedCast(node)
		) {
			errors.push(
				finding(file, sourceFile, node.getStart(sourceFile), "type assertion"),
			);
		} else if (ts.isTypeAssertionExpression(node) && !isJustifiedCast(node)) {
			errors.push(
				finding(file, sourceFile, node.getStart(sourceFile), "type assertion"),
			);
		} else if (ts.isNonNullExpression(node)) {
			errors.push(
				finding(file, sourceFile, node.getStart(sourceFile), "non-null assertion"),
			);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return errors;
}

async function collectTypeScriptSources(
	directory: string,
	repositoryRoot: string,
	vendored: ReadonlySet<string>,
): Promise<TypeScriptSource[]> {
	if (vendored.has(relative(repositoryRoot, directory))) return [];
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error: unknown) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return [];
		}
		throw error;
	}

	const sources: TypeScriptSource[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory()) {
			sources.push(...(await collectTypeScriptSources(path, repositoryRoot, vendored)));
		} else if (
			entry.isFile() &&
			(path.endsWith(".ts") || path.endsWith(".tsx")) &&
			!path.endsWith(".d.ts")
		) {
			sources.push({
				path: relative(repositoryRoot, path),
				source: await readFile(path, "utf8"),
			});
		}
	}
	return sources;
}

/**
 * Reports unsafe type escapes in Orange's TypeScript under `directories`. Code copied unchanged
 * from another project is listed in `vendored` (repository-relative directories) and skipped,
 * so it stays diffable against its upstream.
 */
export async function checkSourceSafety(
	directories: readonly string[],
	repositoryRoot: string,
	vendored: readonly string[] = [],
): Promise<string[]> {
	const vendoredDirectories = new Set(vendored);
	const sources = (
		await Promise.all(
			directories.map((directory) =>
				collectTypeScriptSources(directory, repositoryRoot, vendoredDirectories),
			),
		)
	).flat();
	return sources.flatMap(findUnsafeTypeEscapes);
}
