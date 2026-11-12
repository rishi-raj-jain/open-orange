// Splits SQL into statements like Wrangler's `d1 execute`, which runs the
// statements as one D1 batch. Ported from Wrangler's splitter and trimmer.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/d1/splitter.ts#L18-L38
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/d1/splitter.ts#L132-L262
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/d1/trimmer.ts#L11-L37
export function splitSqlQuery(sql: string): string[] {
	const trimmedSql = trimSqlQuery(sql);
	if (!mayContainMultipleStatements(trimmedSql)) return [trimmedSql];
	const split = splitSqlIntoStatements(trimmedSql);
	return split.length === 0 ? [trimmedSql] : split;
}

function mayContainMultipleStatements(sql: string): boolean {
	const trimmed = sql.trimEnd();
	const semicolonIndex = trimmed.indexOf(";");
	return semicolonIndex !== -1 && semicolonIndex !== trimmed.length - 1;
}

// D1 runs the batch in a transaction, so the wrapping transaction of a
// `sqlite3 .dump` file is removed.
function trimSqlQuery(sql: string): string {
	if (!sql.includes("BEGIN TRANSACTION")) return sql;
	const trimmedSql = sql.replace("BEGIN TRANSACTION;", "").replace("COMMIT;", "");
	if (trimmedSql.includes("BEGIN TRANSACTION")) {
		throw new Error(
			"Orange could not process the provided SQL file, as it contains several transactions.\nD1 runs your SQL in a transaction for you.\nPlease export an SQL file from your SQLite database and try again.",
		);
	}
	return trimmedSql;
}

// The checks below look only at the end of a statement. Wrangler's splitter tests the whole statement
// for each character, which is quadratic in its size: a 1 MB row took 5 minutes.
const statementTailLength = 8;

function splitSqlIntoStatements(sql: string): string[] {
	const statements: string[] = [];
	let statement = "";
	let tail = "";
	const append = (text: string): void => {
		statement += text;
		tail = (tail + text).slice(-statementTailLength);
	};
	// How many BEGIN or CASE blocks are open. A `;` inside one does not end the statement.
	let compoundDepth = 0;
	let index = 0;
	while (index < sql.length) {
		const char = String.fromCodePoint(sql.codePointAt(index) ?? 0);
		index += char.length;
		if (compoundDepth > 0 && /\sEND[;\s]$/i.test(tail + char)) compoundDepth -= 1;
		switch (char) {
			case "'":
			case '"':
			case "`": {
				const end = endOfMarker(sql, index, char);
				append(char + sql.slice(index, end));
				index = end;
				break;
			}
			case "$": {
				let end = index;
				while (end < sql.length) {
					const next = sql[end] ?? "";
					end += 1;
					if (!isDollarQuoteIdentifier(next)) break;
				}
				const dollarQuote = `$${sql.slice(index, end)}`;
				index = end;
				append(dollarQuote);
				if (dollarQuote.endsWith("$")) {
					const close = endOfMarker(sql, index, dollarQuote);
					append(sql.slice(index, close));
					index = close;
				}
				break;
			}
			case "-":
				if (sql[index] === "-") {
					// A line comment ends at the newline, which the statement keeps.
					index = endOfMarker(sql, index + 1, "\n");
					append("\n");
					break;
				}
				append(char);
				continue;
			case "/":
				if (sql[index] === "*") {
					index = endOfMarker(sql, index + 1, "*/");
					break;
				}
				append(char);
				continue;
			case ";":
				if (compoundDepth === 0) {
					statements.push(statement);
					statement = "";
					tail = "";
				} else {
					append(char);
				}
				break;
			default:
				append(char);
				break;
		}
		if (/\s(BEGIN|CASE)\s$/i.test(tail)) compoundDepth += 1;
	}
	statements.push(statement);
	return statements.map((value) => value.trim()).filter((value) => value.length > 0);
}

// The index just past the next `marker`, or the end of the text.
function endOfMarker(sql: string, from: number, marker: string): number {
	const found = sql.indexOf(marker, from);
	return found === -1 ? sql.length : found + marker.length;
}

// A dollar-quote tag holds digits, underscores, and letters.
function isDollarQuoteIdentifier(char: string): boolean {
	return char !== "$" && (/[0-9_]/i.test(char) || char.toLowerCase() !== char.toUpperCase());
}
