-- Private game usage aggregates and server-validated leaderboard records.
-- Anonymous sessions are ephemeral; player_id is reserved for the account follow-up.

CREATE TABLE IF NOT EXISTS game_sessions (
	id                    INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id            TEXT NOT NULL CHECK (length(session_id) = 32),
	run_id                TEXT NOT NULL CHECK (length(run_id) = 36),
	player_id             TEXT,
	game_id               TEXT NOT NULL CHECK (length(game_id) BETWEEN 1 AND 64),
	started_at            INTEGER NOT NULL,
	ended_at              INTEGER,
	last_seen_at          INTEGER NOT NULL,
	last_heartbeat_at     INTEGER NOT NULL,
	active_ms             INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
	ip_address            TEXT NOT NULL,
	user_agent            TEXT NOT NULL DEFAULT '',
	browser               TEXT NOT NULL DEFAULT 'unknown',
	operating_system      TEXT NOT NULL DEFAULT 'unknown',
	device_class          TEXT NOT NULL DEFAULT 'unknown',
	screen_class          TEXT NOT NULL DEFAULT 'unknown',
	input_class           TEXT NOT NULL DEFAULT 'unknown',
	UNIQUE (session_id, game_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_game_sessions_age ON game_sessions (last_seen_at);
CREATE INDEX IF NOT EXISTS idx_game_sessions_game_recent ON game_sessions (game_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_sessions_player ON game_sessions (player_id, game_id) WHERE player_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS game_scores (
	id                    INTEGER PRIMARY KEY AUTOINCREMENT,
	game_id               TEXT NOT NULL CHECK (length(game_id) BETWEEN 1 AND 64),
	mode_id               TEXT NOT NULL CHECK (length(mode_id) BETWEEN 1 AND 32),
	score                 INTEGER NOT NULL CHECK (score >= 0 AND score <= 1000000000),
	tie_break             INTEGER CHECK (tie_break IS NULL OR (tie_break >= 0 AND tie_break <= 1000000000)),
	achieved_at           INTEGER NOT NULL,
	session_id            TEXT NOT NULL CHECK (length(session_id) = 32),
	player_id             TEXT,
	display_name          TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 24),
	validation_state      TEXT NOT NULL CHECK (validation_state IN ('pending', 'validated', 'rejected')),
	idempotency_key       TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 64),
	UNIQUE (session_id, idempotency_key),
	UNIQUE (session_id, game_id, mode_id)
);
CREATE INDEX IF NOT EXISTS idx_game_scores_rank
	ON game_scores (game_id, mode_id, validation_state, score DESC, COALESCE(tie_break, 1000000001) ASC, achieved_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_game_scores_age ON game_scores (achieved_at);
CREATE INDEX IF NOT EXISTS idx_game_scores_player ON game_scores (player_id, achieved_at DESC) WHERE player_id IS NOT NULL;
