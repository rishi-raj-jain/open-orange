CREATE TABLE IF NOT EXISTS comments (
	id INTEGER PRIMARY KEY NOT NULL,
	author TEXT NOT NULL,
	content TEXT NOT NULL
);

INSERT INTO comments (author, content)
VALUES
	('Kristian', 'Congrats!'),
	('Serena', 'Great job!'),
	('Max', 'Keep up the good work!');
