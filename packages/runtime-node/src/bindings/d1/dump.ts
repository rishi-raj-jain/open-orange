import { Buffer } from "node:buffer";

// Reads a D1 export, as Cloudflare's export API writes it, one statement at a time.
//
// Two formats reach Orange. `sqlite3_cli_only`, which `orange migrate d1 --url` asks for, matches the
// `sqlite3` shell's `.dump`: integers and REALs are exact. The default format, which `wrangler d1
// export` writes, passes every number through a JS double, so it rounds integers at or past 2^53. Both
// put each table's rows right after its CREATE TABLE, and the indexes, triggers, and views after
// every row, so a trigger never fires during the copy.

/** A complete statement and the byte offset just past its `;`. */
export interface DumpStatement {
	end: number;
	sql: string;
}

const quoteEnd: Record<number, number> = { 34: 34, 39: 39, 91: 93, 96: 96 };
const semicolon = 59;

// SQLite's IdChar: letters, digits, `_`, `$`, and every byte of a multibyte UTF-8 character.
function isWordByte(byte: number): boolean {
	return (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || byte === 95 || byte === 36 || byte >= 128;
}

function isSpace(byte: number): boolean {
	return byte === 32 || byte === 9 || byte === 10 || byte === 13 || byte === 12;
}

// The offset past the comment or whitespace at `at`, or `at` if there is none. -1: the comment runs
// past the end of `bytes`.
function skipSpaceAndComments(bytes: Uint8Array, at: number): number {
	let index = at;
	for (;;) {
		while (index < bytes.length && isSpace(bytes[index]!)) index += 1;
		if (bytes[index] === 45 && bytes[index + 1] === 45) {
			const newline = bytes.indexOf(10, index + 2);
			if (newline === -1) return -1;
			index = newline + 1;
			continue;
		}
		if (bytes[index] === 47 && bytes[index + 1] === 42) {
			const close = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf("*/", index + 2);
			if (close === -1) return -1;
			index = close + 2;
			continue;
		}
		return index;
	}
}

// The tokens and states of sqlite3_complete(), which the `sqlite3` shell uses to read a file one
// statement at a time, so a dump splits here as the shell splits it. A statement ends at a `;`
// outside quotes and comments, and a CREATE TRIGGER only at `; END ;`. So `NEW.end`, a `begin`
// column, `CASE ... END`, and comments in the trigger's header don't end it.
// https://github.com/sqlite/sqlite/blob/1ee7b58d7e25997af2291698d045a406eeb072c1/src/complete.c#L154-L163
const tkSemi = 0;
const tkSpace = 1;
const tkOther = 2;
const tkExplain = 3;
const tkCreate = 4;
const tkTemp = 5;
const tkTrigger = 6;
const tkEnd = 7;
const transitions: readonly (readonly number[])[] = [
	/* 0 NOTHING */ [1, 0, 2, 3, 4, 2, 2, 2],
	/* 1 START   */ [1, 1, 2, 3, 4, 2, 2, 2],
	/* 2 NORMAL  */ [1, 2, 2, 2, 2, 2, 2, 2],
	/* 3 EXPLAIN */ [1, 3, 3, 2, 4, 2, 2, 2],
	/* 4 CREATE  */ [1, 4, 2, 2, 2, 4, 5, 2],
	/* 5 TRIGGER */ [6, 5, 5, 5, 5, 5, 5, 5],
	/* 6 SEMI    */ [6, 6, 5, 5, 5, 5, 5, 7],
	/* 7 END     */ [1, 7, 5, 5, 5, 5, 5, 5],
];
const keywordTokens: ReadonlyMap<string, number> = new Map([
	["CREATE", tkCreate],
	["END", tkEnd],
	["EXPLAIN", tkExplain],
	["TEMP", tkTemp],
	["TEMPORARY", tkTemp],
	["TRIGGER", tkTrigger],
]);

// The offset past the `;` that ends the statement starting at `start`, or -1 if `bytes` ends first.
function statementEnd(bytes: Uint8Array, start: number): number {
	const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let state = 0;
	let index = start;
	while (index < bytes.length) {
		const byte = bytes[index]!;
		let token = tkOther;
		let next = index + 1;
		const close = quoteEnd[byte];
		if (byte === semicolon) token = tkSemi;
		else if (isSpace(byte)) token = tkSpace;
		else if (byte === 47 && bytes[index + 1] === 42) {
			const end = text.indexOf("*/", index + 2);
			if (end === -1) return -1;
			next = end + 2;
			token = tkSpace;
		} else if (byte === 45 && bytes[index + 1] === 45) {
			const newline = bytes.indexOf(10, index + 2);
			if (newline === -1) return -1;
			next = newline;
			token = tkSpace;
		} else if (close !== undefined) {
			// '' inside '...' (and "" inside "...") is one quote, and the scan just goes on past it.
			const end = bytes.indexOf(close, index + 1);
			if (end === -1) return -1;
			next = end + 1;
		} else if (isWordByte(byte)) {
			while (next < bytes.length && isWordByte(bytes[next]!)) next += 1;
			// The word may go on in the bytes that come next.
			if (next === bytes.length) return -1;
			if (next - index <= 9) token = keywordTokens.get(text.toString("latin1", index, next).toUpperCase()) ?? tkOther;
		}
		state = transitions[state]![token]!;
		if (state === 1 && token === tkSemi) return next;
		index = next;
	}
	return -1;
}

/**
 * The complete statements in `bytes`, and the offset where the rest starts. With `final`, the text
 * after the last `;` counts as one more statement. Offsets are bytes, so a reader can resume at one.
 */
export function splitDump(bytes: Uint8Array, final: boolean): { rest: number; statements: DumpStatement[] } {
	const statements: DumpStatement[] = [];
	let at = 0;
	for (;;) {
		const start = skipSpaceAndComments(bytes, at);
		if (start === -1 || start >= bytes.length) return { rest: start === -1 && !final ? at : bytes.length, statements };
		const end = statementEnd(bytes, start);
		if (end === -1) {
			if (!final) return { rest: at, statements };
			statements.push({ end: bytes.length, sql: Buffer.from(bytes.buffer, bytes.byteOffset + start, bytes.length - start).toString("utf8").trim() });
			return { rest: bytes.length, statements };
		}
		statements.push({ end, sql: Buffer.from(bytes.buffer, bytes.byteOffset + start, end - 1 - start).toString("utf8").trim() });
		at = end;
	}
}

// --- What a statement does ----------------------------------------------------------------------------

export type DumpAction =
	// Runs as is, or with its values rewritten.
	| { kind: "run"; sql: string }
	// Builds an index: a long statement that gets a commit of its own.
	| { kind: "index"; sql: string }
	// Writes `sqlite_sequence`, which exists only once an AUTOINCREMENT table does.
	| { kind: "sequence"; sql: string }
	| { kind: "skip" };

/** A statement that Orange can't take, with the reason. */
export class DumpError extends Error {}

const name = String.raw`(?:"(?:[^"]|"")*"|'(?:[^']|'')*'|\[[^\]]*\]|` + "`[^`]*`" + String.raw`|[^\s(,;]+)`;
// Space between words may hold comments, as in `CREATE /* note */ TRIGGER`.
const gap = String.raw`(?:\s|\/\*[^]*?\*\/|--[^\n]*\n)+`;
const createTarget = new RegExp(
	String.raw`^CREATE${gap}(?:(?:TEMP|TEMPORARY)${gap})?(?:UNIQUE${gap})?(TABLE|INDEX|TRIGGER|VIEW|VIRTUAL${gap}TABLE)${gap}(?:IF${gap}NOT${gap}EXISTS${gap})?(${name})`,
	"i",
);
const insertTarget = new RegExp(String.raw`^(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?(?:INTO\s+)?(${name})`, "i");
const deleteTarget = new RegExp(String.raw`^DELETE\s+FROM\s+(${name})`, "i");

function unquote(text: string): string {
	const first = text[0];
	if (first === '"' || first === "'" || first === "`") return text.slice(1, -1).replaceAll(`${first}${first}`, first);
	if (first === "[") return text.slice(1, -1);
	return text;
}

// Objects Orange's own copy never takes: the move's freeze, D1's own tables, and SQLite's.
function isForeign(objectName: string): boolean {
	const lower = objectName.toLowerCase();
	return lower.startsWith("_orange_d1_") || lower.startsWith("_cf_");
}

/**
 * What to do with one statement of a dump. `checkIntegers` refuses an integer at or past 2^53, which
 * the default format has already rounded.
 */
export function dumpAction(sql: string, checkIntegers: boolean): DumpAction {
	if (/^(?:BEGIN(?:\s+\w+)?(?:\s+TRANSACTION)?|COMMIT|END(?:\s+TRANSACTION)?|PRAGMA\b[^]*)$/i.test(sql)) return { kind: "skip" };
	const created = createTarget.exec(sql);
	if (created !== null) {
		const target = unquote(created[2]!);
		if (isForeign(target)) return { kind: "skip" };
		const kind = created[1]!.toUpperCase();
		if (kind.startsWith("VIRTUAL")) throw new DumpError(`The export holds the virtual table ${target}. Orange's copy does not take virtual tables. Drop it on Cloudflare, export again, and create it again on Orange.`);
		// The shell's dump creates `sqlite_sequence` itself, inside `PRAGMA writable_schema`. SQLite
		// makes it with the first AUTOINCREMENT table.
		if (target.toLowerCase() === "sqlite_sequence") return { kind: "skip" };
		if (kind === "INDEX") return { kind: "index", sql };
		return { kind: "run", sql };
	}
	const inserted = insertTarget.exec(sql) ?? deleteTarget.exec(sql);
	if (inserted !== null) {
		const target = unquote(inserted[1]!).toLowerCase();
		if (isForeign(target)) return { kind: "skip" };
		if (target === "sqlite_schema" || target === "sqlite_master") {
			throw new DumpError("The export writes sqlite_schema, which it does for a virtual table. Orange's copy does not take virtual tables. Drop them on Cloudflare and export again.");
		}
		if (target === "sqlite_sequence") return { kind: "sequence", sql: rewriteValues(sql, false) };
		return { kind: "run", sql: rewriteValues(sql, checkIntegers) };
	}
	return { kind: "run", sql };
}

/** The dump holds the freeze's state row with `frozen`, so the export was made after the freeze. */
export function isFrozenStateRow(sql: string): boolean {
	const inserted = insertTarget.exec(sql);
	return inserted !== null && unquote(inserted[1]!).toLowerCase() === "_orange_d1_state" && /'frozen'/.test(sql);
}

// --- Values -------------------------------------------------------------------------------------------

const twoTo53 = 2n ** 53n;

// SQLite's unistr() escapes: \\, \XXXX, \uXXXX, \+XXXXXX, \UXXXXXXXX.
function decodeUnistr(text: string): string {
	return text.replace(/\\(\\|[0-9A-Fa-f]{4}|u[0-9A-Fa-f]{4}|\+[0-9A-Fa-f]{6}|U[0-9A-Fa-f]{8})/g, (_, escape: string) => {
		if (escape === "\\") return "\\";
		const hex = /^[0-9A-Fa-f]/.test(escape) ? escape : escape.slice(1);
		return String.fromCodePoint(Number.parseInt(hex, 16));
	});
}

const powerOf2Step = 2 ** 52;

/**
 * A REAL as SQL that SQLite computes exactly: its integer mantissa times or over powers of two.
 * SQLite 3.46 turns some decimal texts into a double one bit off (its text-to-REAL conversion is
 * exact only from 3.47), and Orange runs 3.46. A JS number parses correctly, and multiplying or
 * dividing by a power of two is exact while the result is a double, which every step here is.
 */
export function exactReal(value: number): string {
	if (value === Number.POSITIVE_INFINITY) return "9e999";
	if (value === Number.NEGATIVE_INFINITY) return "-9e999";
	if (value === 0) return "0.0";
	const bits = new DataView(new ArrayBuffer(8));
	bits.setFloat64(0, value);
	const high = bits.getUint32(0);
	const biased = (high >>> 20) & 0x7ff;
	let mantissa = BigInt(high & 0xfffff) * 2n ** 32n + BigInt(bits.getUint32(4));
	let exponent = biased === 0 ? -1074 : biased - 1075;
	if (biased !== 0) mantissa += 2n ** 52n;
	while ((mantissa & 1n) === 0n) {
		mantissa >>= 1n;
		exponent += 1;
	}
	const sign = value < 0 ? "-" : "";
	if (exponent >= 0 && mantissa << BigInt(exponent) <= twoTo53) return `CAST(${sign}${mantissa << BigInt(exponent)} AS REAL)`;
	let sql = `CAST(${sign}${mantissa} AS REAL)`;
	for (let rest = Math.abs(exponent); rest > 0; rest -= 52) sql += `${exponent > 0 ? " * " : " / "}${Math.min(powerOf2Step, 2 ** rest)}`;
	return `(${sql})`;
}

const quoted = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/y;
const word = /[A-Za-z_][\w$]*/y;
const number = /[0-9]+(\.[0-9]*)?([eE][-+]?[0-9]+)?|\.[0-9]+([eE][-+]?[0-9]+)?/y;
const unistrCall = /unistr\(\s*'((?:[^']|'')*)'\s*\)/iy;

/**
 * Rewrites the values of an INSERT so SQLite 3.46 reads them back exactly: every REAL becomes
 * `exactReal`, `Inf` and `Infinity` (the shell's and D1's forms of an infinite REAL) become `9e999`,
 * and `unistr('...')` (SQLite 3.50+) becomes the exact bytes of its text. With `checkIntegers`, an
 * integer at or past 2^53 is refused: the default export format has already rounded it.
 */
export function rewriteValues(sql: string, checkIntegers: boolean): string {
	const values = /\bVALUES\s*\(/i.exec(sql);
	if (values === null) return sql;
	let out = sql.slice(0, values.index);
	let index = values.index;
	while (index < sql.length) {
		const char = sql.charCodeAt(index);
		// ' " ` [
		if (char === 39 || char === 34 || char === 96 || char === 91) {
			quoted.lastIndex = index;
			const match = quoted.exec(sql);
			const end = match === null ? sql.length : index + match[0].length;
			out += sql.slice(index, end);
			index = end;
			continue;
		}
		if ((char >= 65 && char <= 90) || (char >= 97 && char <= 122) || char === 95) {
			word.lastIndex = index;
			const name = word.exec(sql)![0];
			if (name === "Inf" || name === "Infinity") {
				out += "9e999";
				index += name.length;
				continue;
			}
			if (name.length === 6 && name.toLowerCase() === "unistr") {
				unistrCall.lastIndex = index;
				const call = unistrCall.exec(sql);
				if (call !== null) {
					const text = decodeUnistr(call[1]!.replaceAll("''", "'"));
					out += `CAST(X'${Buffer.from(text, "utf8").toString("hex")}' AS TEXT)`;
					index += call[0].length;
					continue;
				}
			}
			out += name;
			index += name.length;
			continue;
		}
		if ((char >= 48 && char <= 57) || (char === 46 && /[0-9]/.test(sql[index + 1] ?? ""))) {
			number.lastIndex = index;
			const match = number.exec(sql)!;
			const text = match[0];
			index += text.length;
			const real = match[1] !== undefined || match[2] !== undefined || match[3] !== undefined || text.startsWith(".");
			if (real) {
				// A minus sign before it is SQL's, and applies to the exact value just as well.
				out += exactReal(Number(text));
				continue;
			}
			if (checkIntegers && text.length >= 16 && BigInt(text) >= twoTo53) {
				throw new DumpError(
					`The export holds the integer ${text}, at or past 2^53. D1's default export format rounds such integers, so this value may already be wrong. Run \`orange migrate d1 --url\`, which exports them exactly.`,
				);
			}
			out += text;
			continue;
		}
		out += sql[index];
		index += 1;
	}
	return out;
}
