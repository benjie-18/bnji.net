-- Open lobbies (public room discovery): the listing query is
--   WHERE expires_at > now AND game_id = ? ORDER BY created_at DESC LIMIT n
-- over room_registry, which 0014 indexed only by expiry. This index is the
-- difference between scanning the registry per page view and seeking it.
--
-- This migration also marks a framing change, because applied migrations are
-- never edited: 0014 justified keeping `room_registry.code` out of search
-- indexes and public listings as "what makes the compromise safe". Public
-- listing is now the feature — every live room is listed for anyone to join, by
-- owner request, and the room code is published in exactly one place: the
-- uncached, unauthenticated-but-rate-limited JSON endpoint
-- /api/games/lobbies. What 0014 protected still holds: the code is never in a
-- search index, a prerendered page, a URL, a share link or an analytics event,
-- and a D1 leak no longer grants more than the listing already does — join the
-- room, never read its state.

CREATE INDEX IF NOT EXISTS idx_room_registry_game ON room_registry (game_id, expires_at);
