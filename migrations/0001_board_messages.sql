-- BNJI.NET public message board — initial schema.
--
-- Append-mostly table of short visitor messages with a moderation status.
-- Applied with:
--   local:  npx wrangler d1 migrations apply BOARD_DB --local
--   remote: npx wrangler d1 migrations apply BOARD_DB --remote
--
-- Why this shape:
--  - The public feed query is "status IN (visible, reported) ORDER BY
--    created_at DESC, id DESC" with a keyset cursor on (created_at, id);
--    the composite index below serves exactly that, so pagination never
--    scans hidden/deleted rows.
--  - created_at is epoch millis (integer): compact, index-friendly, and the
--    cursor tie-breaker is the id text column.
--  - The CHECK constraint keeps moderation status a closed set at the storage
--    layer, not just in application code.
CREATE TABLE IF NOT EXISTS board_messages (
	id         TEXT PRIMARY KEY,
	body       TEXT NOT NULL,
	image      TEXT,
	hue        INTEGER NOT NULL DEFAULT 0,
	status     TEXT NOT NULL DEFAULT 'visible'
	           CHECK (status IN ('visible', 'hidden', 'reported', 'deleted')),
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_board_public
	ON board_messages (status, created_at DESC, id DESC);
