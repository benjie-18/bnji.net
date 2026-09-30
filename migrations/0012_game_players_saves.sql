-- Global game accounts and bounded, game-agnostic cross-device save blobs.
CREATE TABLE IF NOT EXISTS game_players (
	id                  TEXT PRIMARY KEY CHECK (length(id) BETWEEN 32 AND 64),
	recovery_hash       TEXT NOT NULL UNIQUE CHECK (length(recovery_hash) = 64),
	display_name        TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 48),
	created_at          INTEGER NOT NULL,
	updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_players_created ON game_players (created_at);

CREATE TABLE IF NOT EXISTS game_player_sessions (
	token_hash          TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
	player_id           TEXT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
	created_at          INTEGER NOT NULL,
	expires_at          INTEGER NOT NULL,
	last_seen_at        INTEGER NOT NULL,
	revoked_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_game_player_sessions_player ON game_player_sessions (player_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_player_sessions_expiry ON game_player_sessions (expires_at);

-- One fixed-window row per hashed client IP; only used for recovery-code sign-ins.
CREATE TABLE IF NOT EXISTS game_auth_attempts (
	ip_hash             TEXT PRIMARY KEY CHECK (length(ip_hash) = 64),
	window_started_at   INTEGER NOT NULL,
	attempts            INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 1000),
	updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_auth_attempts_age ON game_auth_attempts (updated_at);

CREATE TABLE IF NOT EXISTS game_saves (
	player_id           TEXT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
	game_id             TEXT NOT NULL CHECK (length(game_id) BETWEEN 1 AND 64),
	slot_id             TEXT NOT NULL CHECK (length(slot_id) BETWEEN 1 AND 32),
	schema_version      INTEGER NOT NULL CHECK (schema_version BETWEEN 1 AND 10000),
	revision            INTEGER NOT NULL CHECK (revision >= 1),
	data_json           TEXT NOT NULL CHECK (length(CAST(data_json AS BLOB)) <= 16384 AND json_valid(data_json)),
	updated_at          INTEGER NOT NULL,
	PRIMARY KEY (player_id, game_id, slot_id)
);
CREATE INDEX IF NOT EXISTS idx_game_saves_player_updated ON game_saves (player_id, updated_at DESC);
