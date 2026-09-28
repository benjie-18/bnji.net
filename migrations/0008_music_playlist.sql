-- BNJI.NET — the admin-managed music playlist.
--
-- WHY A TABLE AND NOT THE CONFIG ARRAY
-- ------------------------------------
-- The playlist used to live in src/config/music.config.ts: a static array
-- baked into the build, editable only by redeploying. This table makes the
-- playlist data, so the operator can import a Spotify or YouTube link, edit the metadata
-- and reorder the queue from /admin without a deploy.
--
-- The static array is still the SEED (see music_playlist_state below) and the
-- offline fallback, so a deployment that has never been seeded plays exactly
-- what it played before this migration existed.
--
-- ONE DATABASE. This reuses the existing BOARD_DB binding like every other
-- table here; there is no second database and no new binding to configure.
--
-- ORDER IS A COLUMN. `position` is explicit, unique and dense, because
-- reordering is a first-class operator action: insertion time is not the order
-- and cannot be made into it after the fact.
--
-- TWO DATE COLUMNS, ON PURPOSE. `published_at` is when a YouTube video was
-- uploaded; `release_date` is when a Spotify album was released. They are
-- different facts about different things and the player labels them
-- differently ("Published ..." vs "Released ..."), so they are never written to
-- one column and relabelled later.
--
-- NOTE ON THE PROVIDER CHECK: all three providers are live in this build, so
-- the constraint and the code agree. It is written as a CHECK rather than left
-- to the application for the same reason board_messages.status is: a bad
-- provider is a corrupt row, and the cheapest place to refuse one is the one
-- that cannot be bypassed by a future code path.
CREATE TABLE IF NOT EXISTS music_playlist_items (
	-- Server-generated. The seed reuses the config entry's own id so the
	-- seed is idempotent; imported items get a fresh UUID.
	id          TEXT PRIMARY KEY,
	-- Explicit playback order. UNIQUE is load-bearing: it is what makes the
	-- offset-then-rewrite in src/server/music-store.ts a correctness
	-- requirement rather than an optimisation, and it makes a duplicated
	-- position impossible rather than merely unlikely.
	position    INTEGER NOT NULL UNIQUE,
	title       TEXT NOT NULL,
	artist      TEXT,
	album       TEXT,
	published_at TEXT,
	release_date TEXT,
	-- Closed set enforced at the storage layer, like board_messages.status.
	provider    TEXT NOT NULL CHECK (provider IN ('file', 'youtube', 'spotify')),
	-- Direct audio path for 'file', or the canonical https provider link that
	-- was rebuilt from a validated provider id.
	url         TEXT NOT NULL,
	-- The provider id the link was resolved from (Spotify track id, YouTube
	-- video id). Null for 'file'. Kept so an item can be re-resolved later.
	source_id   TEXT,
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL
);

-- Serves the only read pattern there is: the whole queue in order.
CREATE INDEX IF NOT EXISTS idx_music_playlist_order
	ON music_playlist_items (position);

-- ONE ROW, ENFORCED, like admin_credentials. It answers "has this database
-- been seeded?" — which is NOT the same question as "is the playlist empty?".
--
--   seeded = 0  the static playlist has never been copied in. The first read
--               copies it, once.
--   seeded = 1  the playlist is under operator control from now on. An empty
--               table means the operator removed every item, and that is a
--               decision, not a state to repair — so nothing ever re-seeds.
--
-- Without this row the only available check would be COUNT(*) = 0, which
-- cannot tell those two situations apart, and the first empty playlist would
-- silently resurrect the default tracks on the next page view.
CREATE TABLE IF NOT EXISTS music_playlist_state (
	id           INTEGER PRIMARY KEY CHECK (id = 1),
	seeded       INTEGER NOT NULL DEFAULT 0,
	-- Epoch ms of the seed; 0 while unseeded.
	seeded_at    INTEGER NOT NULL DEFAULT 0,
	-- How many items the seed wrote, for a sanity check in the panel.
	source_count INTEGER NOT NULL DEFAULT 0
);

-- The one row, created unseeded. Idempotent, so re-applying the migration on a
-- database that already has it changes nothing.
INSERT OR IGNORE INTO music_playlist_state (id, seeded, seeded_at, source_count)
VALUES (1, 0, 0, 0);
