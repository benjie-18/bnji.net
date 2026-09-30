-- Chat plan Phase C — moderation tooling and admin-visible chat.
--
-- Applied with:
--   local:  npx wrangler d1 migrations apply BOARD_DB --local
--   remote: npx wrangler d1 migrations apply BOARD_DB --remote
--
-- Trade-off accepted by the owner (2026-09-30): `room_registry` stores the
-- room code in D1 so admins can find live Durable Objects. Rooms are 2-hour,
-- 8-seat, code-protected spaces; a D1 compromise would expose joinable rooms
-- for the remainder of their lifetime. This site is for personal use and the
-- owner explicitly accepted the gap — see CHAT-SYSTEM-PLAN.md §6.1.

-- Admin discovery: which rooms exist right now. Written at room creation by
-- the Worker (the only component that both knows the code and can reach D1);
-- deleted by the hourly sweep after expiry and by the admin close action.
CREATE TABLE IF NOT EXISTS room_registry (
  code        TEXT PRIMARY KEY,
  game_id     TEXT NOT NULL,
  owner_hash  TEXT NOT NULL,   -- sha256(room principal), never a raw id
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_room_registry_expires ON room_registry (expires_at);

-- Reports: the message snapshot is taken at REPORT time (plan §6.4), so
-- moderation evidence survives the room's expiry — the DO itself only lives
-- as long as the room. One row per (room, message); report_count is distinct
-- reporters, matching the board's board_reports de-duplication pattern.
-- author_hash = sha256(room principal of the message author): needed for
-- account export/deletion of reported content and for principal bans.
CREATE TABLE IF NOT EXISTS chat_reports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code         TEXT NOT NULL,
  message_n         INTEGER NOT NULL,
  author_hash       TEXT NOT NULL,
  label             TEXT NOT NULL,
  text              TEXT NOT NULL,
  message_at        INTEGER NOT NULL,
  report_count      INTEGER NOT NULL DEFAULT 1,
  first_reported_at INTEGER NOT NULL,
  reported_at       INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',  -- open | resolved | dismissed
  status_note       TEXT,
  moderated_at      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_reports_message ON chat_reports (room_code, message_n);
CREATE INDEX IF NOT EXISTS idx_chat_reports_status ON chat_reports (status, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_reports_author ON chat_reports (author_hash);
CREATE INDEX IF NOT EXISTS idx_chat_reports_age ON chat_reports (reported_at);

-- Distinct-reporter de-duplication (plan §6.4, mirroring 0004_board_moderation).
-- reporter_hash is sha256(room principal of the reporter) — same identifier
-- the room already derives for membership; no IP, no user agent, no cookie.
-- Purged with the reports it counts.
CREATE TABLE IF NOT EXISTS chat_reporters (
  room_code    TEXT NOT NULL,
  message_n    INTEGER NOT NULL,
  reporter_hash TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (room_code, message_n, reporter_hash)
);
CREATE INDEX IF NOT EXISTS idx_chat_reporters_age ON chat_reporters (created_at);

-- Admin audit trail (plan §6.2 "Moderation log — audit only"). target_hash is
-- a room-principal hash; detail is a bounded free-form note. Retention follows
-- the shared sweep window.
CREATE TABLE IF NOT EXISTS chat_moderation_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,     -- delete_message | close_room | ban | unban | report_resolve | report_dismiss | report_escalate
  room_code  TEXT,
  message_n  INTEGER,
  target_hash TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_moderation_log_age ON chat_moderation_log (created_at);
CREATE INDEX IF NOT EXISTS idx_chat_moderation_log_recent ON chat_moderation_log (created_at DESC, id DESC);

-- Plan gap filled (flagged): §6.2/§6.4 promise "ban the principal for a
-- period" but §9.1 lists no storage for it. Room-scoped mutes die with the
-- room and cannot stop a kicked member from rejoining a different room, so a
-- cross-room chat ban needs its own table. Checked at the /ws upgrade while
-- chat is enabled; expired rows are swept hourly.
CREATE TABLE IF NOT EXISTS chat_bans (
  principal_hash TEXT PRIMARY KEY,
  reason         TEXT,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_chat_bans_expiry ON chat_bans (expires_at);
