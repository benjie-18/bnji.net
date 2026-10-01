-- Phase D of docs/CHAT-SYSTEM-PLAN.md: live private messaging (§7, §9.1).
-- Additive only — no existing table is touched.
--
-- Identity (§7.2): dm_conversations.id = sha256([a, b].sort().join(':')) over
-- the two player IDs, so the pair has exactly one row no matter who opens it
-- and the DO name (idFromName of the same digest) can never fork a duplicate.
-- member_lo < member_hi canonically; every per-side column is addressed by
-- side, never by "sender" or "receiver" (anyone may write first).
--
-- Retention (owner answer 2026-09-30): dm_messages purged after
-- DM_CONFIG.retentionDays (60) by the hourly cron; dm_attachments die with
-- their message (or, if never claimed, as stale uploads); dm_reports follow
-- the shared moderation sweep. Conversations are account-lifetime and leave
-- the database through account deletion (§9.3/§9.5).

CREATE TABLE IF NOT EXISTS dm_conversations (
	id TEXT PRIMARY KEY,                -- sha256(sorted player-id pair joined by ':')
	member_lo TEXT NOT NULL,            -- canonical: member_lo < member_hi
	member_hi TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_message_at INTEGER,            -- NULL until the first message lands
	last_seq INTEGER NOT NULL DEFAULT 0, -- highest message number
	read_seq_lo INTEGER NOT NULL DEFAULT 0, -- per-member read watermark (§7.1)
	read_seq_hi INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_conversations_pair
	ON dm_conversations (member_lo, member_hi);

CREATE TABLE IF NOT EXISTS dm_messages (
	conv_id TEXT NOT NULL REFERENCES dm_conversations (id),
	n INTEGER NOT NULL,                 -- monotone sequence per conversation
	sender TEXT NOT NULL,               -- player id (server-side truth; API maps to me/them)
	body TEXT NOT NULL DEFAULT '',      -- sanitised plain text; '' for image-only messages
	image_id TEXT,                      -- dm_attachments.id when attached (D6: D1 base64)
	created_at INTEGER NOT NULL,
	hidden_for INTEGER NOT NULL DEFAULT 0, -- D12 delete-for-me: bit1 = lo, bit2 = hi
	PRIMARY KEY (conv_id, n)
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_created ON dm_messages (created_at);

CREATE TABLE IF NOT EXISTS dm_attachments (
	id TEXT PRIMARY KEY,
	conv_id TEXT NOT NULL REFERENCES dm_conversations (id),
	uploader TEXT NOT NULL,             -- player id that must claim it
	mime TEXT NOT NULL,                 -- sniffed server-side, never the client's claim
	data TEXT NOT NULL,                 -- base64; ≤ DM_CONFIG.images.maxDecodedBytes decoded
	created_at INTEGER NOT NULL,
	claimed_n INTEGER                   -- NULL until a message claims it; stale uploads swept
);
CREATE INDEX IF NOT EXISTS idx_dm_attachments_claimed ON dm_attachments (conv_id, claimed_n);

-- Report evidence (plan §12.5, owner answer: gate filled inside Phase D):
-- content snapshots at report time so moderation survives retention and
-- conversation deletion, mirroring chat_reports' hashed-principal pattern.
CREATE TABLE IF NOT EXISTS dm_reports (
	conv_id TEXT NOT NULL,
	message_n INTEGER NOT NULL,
	author_hash TEXT NOT NULL,          -- sha256('player:' || sender)
	reporter_hash TEXT NOT NULL,        -- sha256('player:' || reporter) of the first reporter
	body TEXT NOT NULL,                 -- snapshot at report time
	image_id TEXT,
	message_at INTEGER NOT NULL,
	report_count INTEGER NOT NULL DEFAULT 1,
	first_reported_at INTEGER NOT NULL,
	reported_at INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
	status_note TEXT,
	moderated_at INTEGER,
	PRIMARY KEY (conv_id, message_n)
);

CREATE TABLE IF NOT EXISTS dm_reporters (
	conv_id TEXT NOT NULL,
	message_n INTEGER NOT NULL,
	reporter_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (conv_id, message_n, reporter_hash)
);
