-- Phase A of docs/CHAT-SYSTEM-PLAN.md: guest display names and account handles.
-- Additive only: no existing row is modified; the database migrates with zero
-- downtime. The application migrates first and always writes both columns.

-- Guest display names, keyed by the SHA-256 digest of the bnji_ps session id
-- (the raw session id is never stored — same rule as every other store).
-- CHECK length mirrors the sanitizer's 1–24 code points: SQLite length()
-- counts characters, i.e. code points, so the two limits agree.
CREATE TABLE IF NOT EXISTS guest_profiles (
	session_hash    TEXT PRIMARY KEY CHECK (length(session_hash) = 64),
	display_name    TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 24),
	created_at      INTEGER NOT NULL,
	updated_at      INTEGER NOT NULL
);

-- Swept hourly by the retention job (updated_at window, mirrors the bnji_ps
-- session lifetime — a guest name outlives no session by more than 30 days).
CREATE INDEX IF NOT EXISTS idx_guest_profiles_updated ON guest_profiles (updated_at);

-- One global handle per account; NULL until claimed. SQLite unique indexes
-- treat NULLs as distinct, so every existing account keeps working untouched.
-- The CHECK keeps the format in the schema: 3–20 chars of [a-z0-9_].
ALTER TABLE game_players ADD COLUMN handle TEXT
	CHECK (handle IS NULL OR (length(handle) BETWEEN 3 AND 20 AND handle NOT GLOB '*[^a-z0-9_]*'));
ALTER TABLE game_players ADD COLUMN handle_changed_at INTEGER;

-- Exact-match lookup plus claim atomicity (the unique index is the final
-- arbiter when two accounts race the same handle).
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_players_handle ON game_players (handle);
