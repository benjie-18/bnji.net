-- Shared board paint canvas.
--
-- Keep one bounded PNG snapshot instead of appending unbounded pointer-event
-- history. A conditional revision update serializes concurrent publishers;
-- recent request IDs make a retry after a lost response idempotent.
CREATE TABLE IF NOT EXISTS board_paint_state (
	id              INTEGER PRIMARY KEY CHECK (id = 1),
	revision        INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
	image           TEXT,
	updated_at      INTEGER NOT NULL DEFAULT 0,
	last_request_id TEXT
);

INSERT OR IGNORE INTO board_paint_state (id, revision, image, updated_at)
VALUES (1, 0, NULL, 0);

CREATE TABLE IF NOT EXISTS board_paint_commits (
	request_id TEXT PRIMARY KEY,
	revision   INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_board_paint_commits_created
	ON board_paint_commits (created_at DESC);
