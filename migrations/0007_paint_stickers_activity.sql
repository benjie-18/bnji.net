-- Editable shared Paint stickers and a private, bounded publish summary trail.
--
-- Sticker images are resized in the browser and kept with stable IDs in the
-- singleton snapshot. The activity trail stores no artwork or pointer events.
ALTER TABLE board_paint_state
	ADD COLUMN stickers_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS board_paint_activity (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at  INTEGER NOT NULL,
	revision    INTEGER NOT NULL UNIQUE CHECK (revision > 0),
	visitor_id  TEXT NOT NULL CHECK (length(visitor_id) = 36),
	actions_json TEXT NOT NULL CHECK (length(actions_json) <= 512)
);

CREATE INDEX IF NOT EXISTS idx_board_paint_activity_created
	ON board_paint_activity (created_at DESC, id DESC);
