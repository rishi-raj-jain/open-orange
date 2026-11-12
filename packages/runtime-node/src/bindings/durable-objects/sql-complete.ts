// A port of SQLite's sqlite3_complete() state machine with workerd's early exit: the length of
// the first complete statement at the start of `sql`, or 0 when it has none. Lengths count
// UTF-16 code units. The machine only matches ASCII, and every code unit at or above 0x80 is an
// identifier character, as every byte at or above 0x80 is in SQLite.
// https://github.com/sqlite/sqlite/blob/version-3.44.0/src/complete.c#L104-L262
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/patches/sqlite/0003-sqlite-complete-early-exit.patch

const enum Token {
	Semi = 0,
	Whitespace = 1,
	Other = 2,
	Explain = 3,
	Create = 4,
	Temp = 5,
	Trigger = 6,
	End = 7,
}

// State: 0 invalid, 1 start, 2 normal, 3 explain, 4 create, 5 trigger, 6 semi, 7 end.
const transitions: readonly (readonly number[])[] = [
	[1, 0, 2, 3, 4, 2, 2, 2],
	[1, 1, 2, 3, 4, 2, 2, 2],
	[1, 2, 2, 2, 2, 2, 2, 2],
	[1, 3, 3, 2, 4, 2, 2, 2],
	[1, 4, 2, 2, 2, 4, 5, 2],
	[6, 5, 5, 5, 5, 5, 5, 5],
	[6, 6, 5, 5, 5, 5, 5, 7],
	[1, 7, 5, 5, 5, 5, 5, 5],
];

function nextState(state: number, token: Token): number {
	const next = transitions[state]?.[token];
	if (next === undefined) throw new Error(`Invalid SQL completion state ${state}`);
	return next;
}

function isIdentifierCharacter(code: number): boolean {
	return (
		(code >= 0x30 && code <= 0x39) ||
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		code === 0x24 ||
		code === 0x5f ||
		code >= 0x80
	);
}

function keywordToken(word: string): Token {
	switch (word.toLowerCase()) {
		case "create":
			return Token.Create;
		case "trigger":
			return Token.Trigger;
		case "temp":
		case "temporary":
			return Token.Temp;
		case "end":
			return Token.End;
		case "explain":
			return Token.Explain;
		default:
			return Token.Other;
	}
}

export function firstCompleteStatementLength(sql: string): number {
	let state = 0;
	let length = 0;
	scanTokens(sql, (token, end) => {
		state = nextState(state, token);
		if (state !== 1) return true;
		length = end;
		return false;
	});
	return length;
}

/** Whether `sql` holds a token other than whitespace, comments, and semicolons. */
function hasStatementToken(sql: string): boolean {
	let found = false;
	scanTokens(sql, (token) => {
		found = token !== Token.Semi && token !== Token.Whitespace;
		return !found;
	});
	return found;
}

/**
 * Where workerd's exec() would find SQL that holds no statement: the offset of the first
 * statement-less piece, or undefined when every piece is a statement. Workerd prepares the code
 * one statement at a time and skips whitespace after each, so an empty input, a lone `;`, or a
 * tail of only comments fails after the statements before it ran.
 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/util/sqlite.c%2B%2B#L826-L870
 */
export function findStatementlessSql(sql: string): number | undefined {
	let offset = 0;
	for (;;) {
		const rest = sql.slice(offset);
		const length = firstCompleteStatementLength(rest);
		if (length === 0) {
			if (hasStatementToken(rest)) return undefined;
			return offset > 0 && rest.trim() === "" ? undefined : offset;
		}
		if (!hasStatementToken(rest.slice(0, length))) return offset;
		offset += length;
	}
}

// Calls `visit` with each token and the offset just past it, until `visit` returns false or the
// input ends. An unterminated string, identifier, or comment ends the scan.
function scanTokens(sql: string, visit: (token: Token, end: number) => boolean): void {
	let index = 0;
	while (index < sql.length) {
		const char = sql.charAt(index);
		let token: Token;
		switch (char) {
			case ";":
				token = Token.Semi;
				break;
			case " ":
			case "\r":
			case "\t":
			case "\n":
			case "\f":
				token = Token.Whitespace;
				break;
			case "/": {
				if (sql[index + 1] !== "*") {
					token = Token.Other;
					break;
				}
				const close = sql.indexOf("*/", index + 2);
				if (close === -1) return;
				index = close + 1;
				token = Token.Whitespace;
				break;
			}
			case "-": {
				if (sql[index + 1] !== "-") {
					token = Token.Other;
					break;
				}
				const newline = sql.indexOf("\n", index);
				if (newline === -1) return;
				index = newline;
				token = Token.Whitespace;
				break;
			}
			case "[": {
				const close = sql.indexOf("]", index + 1);
				if (close === -1) return;
				index = close;
				token = Token.Other;
				break;
			}
			case "`":
			case '"':
			case "'": {
				const close = sql.indexOf(char, index + 1);
				if (close === -1) return;
				index = close;
				token = Token.Other;
				break;
			}
			default: {
				if (!isIdentifierCharacter(sql.charCodeAt(index))) {
					token = Token.Other;
					break;
				}
				let end = index + 1;
				while (end < sql.length && isIdentifierCharacter(sql.charCodeAt(end))) end += 1;
				token = keywordToken(sql.slice(index, end));
				index = end - 1;
				break;
			}
		}
		index += 1;
		if (!visit(token, index)) return;
	}
}
