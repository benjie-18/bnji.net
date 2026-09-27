-- BNJI.NET — security event logging schema.
--
-- Records request metadata for abuse-detection on public profile endpoints
-- (views, reactions, link clicks). Structurally separate from the public
-- analytics tables (profile_views, profile_reactions, profile_link_clicks)
-- so that security data can never leak into public responses.
--
-- Purpose: detect and respond to abuse (reaction/view spam, bot traffic,
-- rate-limit evasion via cookie-cycling, board message abuse).
--
-- Fields collected:
--   SERVER-SIDE (from Cloudflare headers on every request):
--     ip_address, user_agent, cf_country, cf_city, cf_asn,
--     geo_latitude, geo_longitude (from cf.latitude/cf.longitude),
--     referrer (Referer header)
--   CLIENT-SIDE (sent via POST beacon after page load):
--     screen_width, screen_height, screen_pixel_ratio,
--     hardware_concurrency, device_memory, platform,
--     timezone, language, webgl_renderer,
--     touch_support, device_fingerprint
--   SESSION:
--     session_key, fingerprint (server-side hash), created_at
--
-- SURFACE — which part of the site the event came from:
--   'profile'  a profile page (view, react, link-click, link-redirect)
--   'board'    the public message board (board-view, board-post, board-report)
--   'dm'       the private direct-message form (dm-post)
--   profile_slug is NULL for board/dm events: those surfaces have no profile.
--   target_id links the event to the row it acted on when there is one
--   (a board message id, a link id) so an admin can join the two.
--
-- Retention: 60 days. Rows older than that are purged on admin reads (lazy
-- cleanup). 60 days is long enough to detect sustained abuse patterns and
-- short enough to satisfy Quebec Law 25 and PIPEDA data-minimisation
-- principles for security-incident investigation.
--
-- Privacy: IP addresses, user-agent strings, referrers, precise geolocation,
-- and device identifiers are personal information under Law 25 and PIPEDA.
-- All data in this table is server-only and must never reach any public
-- surface. Access is gated behind the admin surface (ACCESS_TOKEN).
--
-- Applied with:
--   local:  npx wrangler d1 migrations apply BOARD_DB --local
--   remote: npx wrangler d1 migrations apply BOARD_DB --remote

CREATE TABLE IF NOT EXISTS security_events (
	id                  INTEGER PRIMARY KEY AUTOINCREMENT,
	-- 'profile' | 'board' | 'dm'
	surface             TEXT NOT NULL DEFAULT 'profile'
	                   CHECK (surface IN ('profile', 'board', 'dm')),
	-- NULL for board/dm events: those surfaces are not tied to a profile.
	profile_slug        TEXT,
	endpoint            TEXT NOT NULL,
	-- The row this event acted on (board message id, link id), when there is one.
	target_id           TEXT,
	ip_address          TEXT NOT NULL,
	user_agent          TEXT,
	cf_country          TEXT,
	cf_city             TEXT,
	cf_asn              TEXT,
	fingerprint         TEXT,
	session_key         TEXT,
	created_at          INTEGER NOT NULL,
	-- Precise geolocation from Cloudflare cf.latitude/cf.longitude.
	geo_latitude        REAL,
	geo_longitude       REAL,
	-- Referrer URL (may contain personal browsing history).
	referrer            TEXT,
	-- Client-enriched fields (sent via POST beacon after page load).
	screen_width        INTEGER,
	screen_height       INTEGER,
	screen_pixel_ratio  REAL,
	hardware_concurrency INTEGER,
	device_memory       REAL,
	platform            TEXT,
	timezone            TEXT,
	language            TEXT,
	webgl_renderer      TEXT,
	touch_support       INTEGER,
	-- Combined device fingerprint hash (screen + hardware + UA).
	device_fingerprint  TEXT
);

-- Retention cleanup: DELETE WHERE created_at < (now - 60 days).
-- This index supports the purge query efficiently.
CREATE INDEX IF NOT EXISTS idx_security_events_age
	ON security_events (created_at);

-- Per-endpoint queries (admin view, abuse investigation).
CREATE INDEX IF NOT EXISTS idx_security_events_endpoint
	ON security_events (profile_slug, endpoint, created_at);

-- Per-surface admin queries: "show me board activity, newest first".
-- Covers the surface filter plus the retention scan without a table scan.
CREATE INDEX IF NOT EXISTS idx_security_events_surface
	ON security_events (surface, created_at DESC);

-- Joining an event back to the row it acted on (board moderation triage).
CREATE INDEX IF NOT EXISTS idx_security_events_target
	ON security_events (surface, target_id);