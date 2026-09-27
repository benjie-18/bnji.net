-- BNJI.NET — admin credential storage.
--
-- WHY A TABLE, AND WHY A HASH
-- ---------------------------
-- The admin access token used to live only in an environment variable
-- (ACCESS_TOKEN) and was compared verbatim. Environment variables are not
-- "in the database or in code", but they are still a plaintext secret that
-- has to be copied by hand, cannot be rotated from the app, and cannot be
-- changed from the panel. This table makes the hashed token the single
-- source of truth so the panel can rotate it without a redeploy.
--
-- SHA-256 of a short numeric token is fast, which means it is NOT a good
-- general password hash — a real password store would want a slow KDF
-- (scrypt/argon2) with a per-row salt. That is the right trade here
-- precisely because this is not a password: it is a single shared secret
-- for one operator, the row is protected by the same secret, and there is
-- no per-user table to harvest. The threat model is "someone gets the
-- database" — and against that, a fast hash still means a stolen dump
-- yields no plaintext. An offline attacker who can copy the database can
-- also simply try six-digit numbers, so the real defence against guessing
-- remains the login rate limit (see src/pages/api/admin/session.ts).
--
-- ONE ROW, ENFORCED. `id = 1` plus the CHECK below makes a second admin
-- impossible at the storage layer: this site has one operator, and the
-- schema should say so rather than leaving it to application discipline.

CREATE TABLE IF NOT EXISTS admin_credentials (
	id         INTEGER PRIMARY KEY CHECK (id = 1),
	-- hex(sha256(token)). Never the token itself.
	token_hash TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);

-- Seed the initial access token.
--
-- ⚠️  THIS ROW IS NOT A SECRET. The seed token was supplied in the build
--     request and is published in the handover notes, so anyone who reads
--     them can sign in. Change it IMMEDIATELY on first login via
--     Settings → Access token in /admin, which rewrites this row and
--     invalidates every existing session.
--
--     Only the digest is stored. The plaintext appears nowhere in the
--     repository — including in this comment — so it cannot leak from a
--     `git grep`, a build artifact, or a diff. The /admin panel shows
--     "seeded, never rotated" until the first change, which is how the
--     operator is told to come here and fix it.
--
--     To reseed manually (e.g. if the token is lost), compute
--     hex(sha256(<new token>)) and replace the literal below.
INSERT OR IGNORE INTO admin_credentials (id, token_hash, updated_at)
VALUES (1, '26cc435143c4926972d65ef8b6c331961613270cf4801a2ede45048e8d9a0012', 0);
