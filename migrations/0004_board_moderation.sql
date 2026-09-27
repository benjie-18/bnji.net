-- BNJI.NET public message board — moderation support.
--
-- 0001 created board_messages with a `status` column, and board-store.ts
-- exposes setStatus() plus a public filter that already treats 'reported'
-- as public. But nothing could ever move a message INTO 'reported', and
-- nothing tracked WHO reported it or WHEN. This migration closes that gap so
-- the moderation column is reachable from a real flow instead of being a
-- dangling contract.
--
-- report_count   how many distinct reports this message has drawn. Drives
--                auto-escalation: a message that keeps getting reported is
--                easy to spot in the admin triage list.
-- reported_at    epoch ms of the MOST RECENT report (NULL until first one).
-- status_note    free-form moderator note — why something was hidden or
--                deleted. Kept server-side and never returned publicly.
-- moderated_at   epoch ms of the last moderator status change (NULL until
--                a moderator acts). Distinguishes "reported by visitors"
--                from "acted on by a human".
--
-- Reports are counted from DISTINCT sessions, not raw POSTs: the report
-- endpoint is rate limited per client, but a client that clears its
-- session cookie could otherwise inflate its own report count. The reporter
-- identity is deliberately NOT stored — the count and the timestamp are what
-- moderation actually needs, and an attribution list would be a store of
-- "who disliked what", which is personal data with no investigative value
-- beyond the count itself.
--
-- Applied with:
--   local:  npx wrangler d1 migrations apply BOARD_DB --local
--   remote: npx wrangler d1 migrations apply BOARD_DB --remote

ALTER TABLE board_messages ADD COLUMN report_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE board_messages ADD COLUMN reported_at INTEGER;
ALTER TABLE board_messages ADD COLUMN status_note TEXT;
ALTER TABLE board_messages ADD COLUMN moderated_at INTEGER;

-- Triage list: "reported messages, most-reported first" — the admin's
-- default moderation queue. Descending report_count puts the messages that
-- drew the most reports at the top.
CREATE INDEX IF NOT EXISTS idx_board_reported
	ON board_messages (report_count DESC, created_at DESC)
	WHERE status = 'reported';

-- Admin browse: every status, newest first. The public index in 0001 leads
-- with `status`, so it cannot serve an unfiltered newest-first listing once
-- hidden/deleted rows are included.
CREATE INDEX IF NOT EXISTS idx_board_admin
	ON board_messages (created_at DESC, id DESC);

-- Report de-duplication.
--
-- The board rate-limits reports per client, but a rate limit is not identity:
-- a caller who clears their session cookie gets a fresh budget. Without a
-- de-duplication key, one determined visitor could report the same message
-- 200 times and manufacture a "200 reports" signal out of thin air, which
-- would corrupt the exact number a moderator triages on.
--
-- So reports are keyed by (message_id, reporter_key) and INSERT OR IGNORE
-- means a repeat report is a no-op. reporter_key is the ephemeral session id
-- — not an IP, not a fingerprint, not a durable identifier. It cannot be
-- traced back to a person across sessions or devices, and the table holds no
-- text, no contact detail, and no timestamps beyond "when".
--
-- Deliberately NOT stored here: the reporter's IP or user-agent. Those live
-- in security_events, where they are already retained for 60 days under the
-- documented abuse-detection purpose, and joining them here would silently
-- create a second, undeclared store of "who reported what".
CREATE TABLE IF NOT EXISTS board_reports (
	message_id  TEXT NOT NULL,
	reporter_key TEXT NOT NULL,
	created_at  INTEGER NOT NULL,
	PRIMARY KEY (message_id, reporter_key)
) WITHOUT ROWID;

-- Retention sweep for reports: a report only matters while the message is
-- still being triaged. The security_events purge (60 days) and this one share
-- the same window, so the two tables age out together.
CREATE INDEX IF NOT EXISTS idx_board_reports_age
	ON board_reports (created_at);
