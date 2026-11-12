-- The source database of the `orange migrate d1` tests. `capture.ts` loads this file into a real D1
-- database and saves Cloudflare's own export of it in exports/, so the tests' Cloudflare serves a real
-- dump. Change this file only together with a new capture.
CREATE TABLE owners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE);
CREATE TABLE pets (
	id INTEGER PRIMARY KEY,
	owner INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
	big INTEGER,
	price REAL,
	photo BLOB,
	note TEXT
);
CREATE INDEX pets_owner ON pets(owner);
CREATE TABLE tags (owner INTEGER NOT NULL, label TEXT NOT NULL, weight REAL, PRIMARY KEY (owner, label)) WITHOUT ROWID;
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT NOT NULL);
CREATE TRIGGER owners_audit AFTER INSERT ON owners BEGIN INSERT INTO audit(what) VALUES ('owner ' || NEW.name); END;
CREATE VIEW owner_names AS SELECT id, name FROM owners;
-- Snowflake-style keys: D1's default export rounds them to the same double.
CREATE TABLE events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT);
CREATE UNIQUE INDEX events_at ON events(at);
-- Rowids that a table without INTEGER PRIMARY KEY does not keep in any export.
CREATE TABLE notes (body TEXT, n ANY);
CREATE TABLE strict_values (id INTEGER PRIMARY KEY, any_value ANY, real_value REAL) STRICT;
CREATE TABLE generated (id INTEGER PRIMARY KEY, a INTEGER, twice INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL, thrice INTEGER GENERATED ALWAYS AS (a * 3) STORED);
CREATE TABLE "odd ""name""" ("select" TEXT, "col;umn" INTEGER);
-- REAL keys, read in pages. The first page ends at 50 * 1.37e-312, a subnormal double whose
-- 17-digit text SQLite 3.46 reads one bit low, so a page that starts after it starts at it.
CREATE TABLE measures (x REAL PRIMARY KEY, label TEXT) WITHOUT ROWID;
-- `end` and `begin` are keywords that SQLite also takes as names, unquoted, and `.dump` prints the
-- trigger as written.
CREATE TABLE spans (id INTEGER PRIMARY KEY, start INTEGER, end INTEGER, begin TEXT);
CREATE TABLE span_log (id INTEGER PRIMARY KEY, end INTEGER, begin TEXT, kind TEXT);
CREATE TRIGGER spans_log AFTER INSERT ON spans BEGIN
	INSERT INTO span_log(end, begin, kind) VALUES (NEW.end, NEW.begin, CASE WHEN NEW.end > NEW.start THEN 'forward' ELSE 'back' END);
	SELECT NEW.end;
	SELECT NEW.begin;
END;

INSERT INTO owners(name, email) VALUES ('ada', 'ada@example.com'), ('grace', 'grace@example.com'), ('o''brien', NULL), ('lin', 'lin@example.com');
DELETE FROM owners WHERE name = 'lin';
INSERT INTO pets(id, owner, big, price, photo, note) VALUES
	(1, 1, 9223372036854775807, 0.1, X'00FF10', 'semi;colon'),
	(2, 2, -9223372036854775808, 1e308, X'', 'line
break'),
	(3, 3, 9007199254740993, -2.5e-310, NULL, 'unicode ✓ 𝄞'),
	(10, 1, 0, 3.0, X'AB', NULL),
	(11, 2, -9007199254740993, 9e999, zeroblob(3), 'tab	and' || char(13) || 'return'),
	(12, 3, 4611686018427387904, -9e999, X'0000', '');
INSERT INTO pets(id, owner, big, price, photo, note)
	WITH RECURSIVE n(i) AS (SELECT 1000 UNION ALL SELECT i + 1 FROM n WHERE i < 5999)
	SELECT i, 1 + i % 3, i * 1537228672809129, i / 7.0, unhex(printf('%08d', i) || hex(zeroblob(200))), 'pet ' || i FROM n;
INSERT INTO tags(owner, label, weight) VALUES (1, 'calm', 0.5), (1, 'fast', 1.25), (2, 'calm', 2), (3, 'x''y', NULL), (9007199254740993, 'big key', 4.9e-324);
INSERT INTO events(id, at, kind) VALUES
	(1152921504606846977, 9007199254740993, 'a'),
	(1152921504606846978, 9007199254740994, 'b'),
	(1152921504606846979, 9007199254740995, 'c');
INSERT INTO notes(body, n) VALUES ('first', 1), ('second', 2.0), ('third', '3'), ('fourth', X'04');
DELETE FROM notes WHERE body = 'second';
INSERT INTO strict_values(id, any_value, real_value) VALUES (1, 2.0, 2), (2, 9223372036854775806, 0.30000000000000004), (3, 'text', 1.7976931348623157e308), (4, X'FF', NULL);
INSERT INTO generated(id, a) VALUES (1, 10), (2, 20);
INSERT INTO "odd ""name"""("select", "col;umn") VALUES ('a ''quoted'' value', 1);
INSERT INTO spans(start, end, begin) VALUES (1, 5, 'a'), (9, 2, 'b');
INSERT INTO measures(x, label)
	WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
	SELECT (i - 950) * 1.37e-312, 'm ' || i FROM n;
