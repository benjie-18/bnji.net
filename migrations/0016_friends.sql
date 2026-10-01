-- Phase E (chat plan §8.1): friends, requests and blocks.
--
-- Canonical pair ordering (player_a < player_b) mirrors dm_conversations so a
-- friendship is a single row no matter who asked. `requested_by` records who
-- initiated, so a mutual request can auto-accept (§8.1) and pending rows can
-- be split into incoming/outgoing without a second table.
--
-- Friend lists are private to the account (§8.1); there is no admin surface
-- and no public endpoint that lists other players' friendships. Rows live for
-- the account lifetime and cascade on account deletion (§9.5).

CREATE TABLE IF NOT EXISTS player_friends (
  player_a TEXT NOT NULL, player_b TEXT NOT NULL,   -- canonical: a < b
  state    TEXT NOT NULL CHECK (state IN ('pending','accepted','declined')),
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_a, player_b)
);

CREATE TABLE IF NOT EXISTS player_blocks (
  blocker TEXT NOT NULL, blocked TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker, blocked)
);
