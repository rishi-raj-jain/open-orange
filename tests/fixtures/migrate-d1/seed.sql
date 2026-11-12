-- A child table comes first, so a copy has to defer its foreign keys.
CREATE TABLE pets(id INTEGER PRIMARY KEY, owner INTEGER NOT NULL REFERENCES owners(id), blob BLOB, price REAL, note TEXT);
CREATE TABLE owners(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
CREATE INDEX pets_owner ON pets(owner);
CREATE VIEW pet_names AS SELECT pets.id, owners.name FROM pets JOIN owners ON owners.id = pets.owner;
CREATE TABLE audit(id INTEGER PRIMARY KEY, what TEXT);
CREATE TRIGGER pets_audit AFTER INSERT ON pets BEGIN INSERT INTO audit(what) VALUES ('pet ' || NEW.id); END;
INSERT INTO owners(name) VALUES ('ada'), ('grace'), ('o''brien'), ('deleted later');
DELETE FROM owners WHERE name = 'deleted later';
INSERT INTO pets(owner, blob, price, note) VALUES (1, X'00FF10', 1.5, 'semi;colon'), (2, NULL, 2.0, 'line
break'), (3, X'AB', 12345678.25, 'unicode ✓');
