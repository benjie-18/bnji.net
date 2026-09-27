-- BNJI.NET — profile analytics schema.
--
-- Tables for profile views (with daily session dedup), link-click tracking,
-- and lightweight emoji reactions. All times are epoch ms.
--
-- Applied with:
--   local:  npx wrangler d1 migrations apply BOARD_DB --local
--   remote: npx wrangler d1 migrations apply BOARD_DB --remote

-- Profile views with per-session daily deduplication.
-- A view is counted once per (profile_slug, session_key, day_key) triple so
-- repeated refreshes do not inflate the counter. session_key is an ephemeral
-- random cookie value; day_key is YYYY-MM-DD in UTC.
CREATE TABLE IF NOT EXISTS profile_views (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	profile_slug TEXT NOT NULL,
	session_key  TEXT NOT NULL,
	day_key      TEXT NOT NULL,
	created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_views_lookup
	ON profile_views (profile_slug, session_key, day_key);

CREATE INDEX IF NOT EXISTS idx_profile_views_count
	ON profile_views (profile_slug, created_at);

-- Link-click events for profile link tracking.
CREATE TABLE IF NOT EXISTS profile_link_clicks (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	profile_slug TEXT NOT NULL,
	link_id      TEXT NOT NULL,
	session_key  TEXT,
	created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_link_clicks_lookup
	ON profile_link_clicks (profile_slug, link_id, created_at);

-- Lightweight reactions (emoji-based, per session).
-- session_key prevents the same session from reacting twice to the same
-- profile + reaction combo within the cooldown window.
CREATE TABLE IF NOT EXISTS profile_reactions (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	profile_slug TEXT NOT NULL,
	reaction     TEXT NOT NULL,
	session_key  TEXT NOT NULL,
	created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reactions_counts
	ON profile_reactions (profile_slug, reaction, created_at);

CREATE INDEX IF NOT EXISTS idx_reactions_session
	ON profile_reactions (profile_slug, reaction, session_key, created_at);