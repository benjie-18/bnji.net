# Deploying an update to bnji.net

This is the owner-facing runbook. It answers one question: *after I pull, what
do I have to do?*

The Games foundation has additive D1 migrations `0011_games.sql` (tracking/scores) and `0012_game_players_saves.sql` (players/sessions/auth throttling/saves), an hourly retention Cron Trigger, and a new SQLite Durable Object class (`GameRoom`) for generic rooms. It reuses the existing D1/KV; there is no new database, bucket, secret, third-party service, or credential to provision. The chat plan's Phase A adds one more additive migration, `0013_names.sql` (guest display names + account handles) — again no new binding, secret, or paid resource. Phase B (room chat) adds **no migration and no binding**: its tables live inside the existing `GameRoom` DO's own SQLite and are created by the DO's init code. Phase C (moderation tooling) adds one additive migration, `0014_chat_moderation.sql` (five D1 tables: room registry, reports, reporters, moderation log, bans) and **no new binding or secret**: the DO's service-authenticated admin endpoints derive their token from the existing `ACCESS_SECRET` (same value as admin sessions), which `wrangler.json` already passes to the `GameRoom` class as a top-level secret. Phase D (live private messaging) adds one additive migration, `0015_dm.sql` (five D1 tables: `dm_conversations`, `dm_messages`, `dm_attachments`, `dm_reports`, `dm_reporters`) and **one new SQLite Durable Object class, `DMConversation`**, under Wrangler migration tag `dm-conversations-v1` with the `DM_CONVERSATIONS` binding — still no new secret, no new database, no R2 bucket and no paid resource (images ship as D1 base64 per the owner's answer on plan D6). Phase E (friends, presence, notifications) adds one additive migration, `0016_friends.sql` (two D1 tables: `player_friends`, `player_blocks`) and **one new SQLite Durable Object class, `Presence`**, under Wrangler migration tag `presence-v1` with the `PRESENCE` binding — the DO holds sockets and attachments only, writes nothing durable, and never touches KV. For the full current Games rollout checklist, quotas, local
Worker testing, and rollback notes, see [`GAMES-OPERATIONS.md`](./GAMES-OPERATIONS.md).
The migration command is safe to re-run; D1 applies only what is missing.

> **Upcoming — friends and presence (chat plan Phase E).**
> Phases A–D of [`CHAT-SYSTEM-PLAN.md`](./CHAT-SYSTEM-PLAN.md) have landed with
> their own rows below (names/handles `0013`, moderation `0014`, DM tables
> `0015`, friends/blocks `0016`, and the `GameRoom`, `DMConversation` +
> `Presence` SQLite classes). Still to come: nothing on the chat plan's
> critical path — possibly an R2 bucket for DM images if the owner ever
> provisions one (plan D6 stays D1 base64 until then).
> Under [`DEPENDENCY-POLICY.md`](./DEPENDENCY-POLICY.md) §6 each of those is a
> **separate owner decision** with its own rollout row here before it ships.
> Nothing in this section is provisioned today, and no action is required until
> a phase lands. When one does, this table gains its row, the retention values
> land in `src/config/`, and the `docs/DATA.md` §11 register entry is written in
> the same change.

---

## 0. Current Games rollout

| Area | Change | Owner action |
| --- | --- | --- |
| D1 | Additive migrations `0011_games.sql` (sessions/scores), `0012_game_players_saves.sql` (players, digested sessions, hashed-IP auth limits, bounded saves), `0013_names.sql` (guest display names, account handles) and `0014_chat_moderation.sql` (Phase C: room registry, reports, reporters, moderation log, bans) and `0015_dm.sql` (Phase D: `dm_conversations`, `dm_messages`, `dm_attachments`, `dm_reports`, `dm_reporters`) and `0016_friends.sql` (Phase E: `player_friends`, `player_blocks`) and `0017_room_lobby_index.sql` (open lobbies: one index on `room_registry (game_id, expires_at)`; no table, no column, no data change) | Apply only pending migrations to existing `bnji-board` after backup |
| Worker / Durable Objects | Astro HTTP handler, hourly retention Cron, SQLite class `GameRoom` (migration `game-rooms-v1`) and SQLite class `DMConversation` (migration `dm-conversations-v1`, binding `DM_CONVERSATIONS`) and SQLite class `Presence` (migration `presence-v1`, binding `PRESENCE`) | Deploy `src/worker.ts`; Wrangler applies the new class migrations; confirm trigger and all three bindings |
| Admin | Games & play view and configurable raw tracking retention | No new credential; existing `/admin` guard applies |
| Secrets/resources | No new secret, paid product, or third-party service; Phases D+E add only the free `DM_CONVERSATIONS` and `PRESENCE` DO bindings (no R2) | None |

The full current checklist—including local Worker/Durable Object verification, Free quotas, privacy, score-verifier setup and rollback—is in
[`GAMES-OPERATIONS.md`](./GAMES-OPERATIONS.md). The rest of this document
preserves shared owner guidance; the migration list below is based on actual
pending D1 history, not a fixed expected list.

---

## 1. Pull

```bash
git checkout main
git pull
```

## 2. Apply the database migrations

Your database already exists and already has the board table. D1 records which
migrations have run in its own `d1_migrations` table, so this command applies
**only what is missing** and leaves existing rows alone. It is safe to re-run.

```bash
npx wrangler d1 migrations apply bnji-board --remote
```

The unapplied list depends on the database's migration history. If it is already current through `0010_secret_code_uses.sql`, it should list `0011_games.sql`, `0012_game_players_saves.sql`, `0013_names.sql`, `0014_chat_moderation.sql`, `0015_dm.sql`, `0016_friends.sql` and `0017_room_lobby_index.sql` (unless earlier ones were applied already). Review the list before continuing. If legacy migrations also
appear, confirm that is expected for the target database; migration `0001`
should not be assumed harmless merely because it uses `CREATE TABLE IF NOT
EXISTS`—review the database state and backup first.

**To check before applying** (read-only, safe):

```bash
npx wrangler d1 migrations list bnji-board --remote
```

Anything under "Migrations to be applied" is what the next command will run.

### What the new migrations create

| Table | Used by | Notes |
| --- | --- | --- |
| `profile_views` | `/gizlyy/` view counter | One row per (profile, session, UTC day), so refreshing does not inflate the number |
| `profile_link_clicks` | `/gizlyy/` link clicks | Per-link counters |
| `profile_reactions` | `/gizlyy/` emoji reactions | One per session per reaction |
| `security_events` | Abuse detection | IP, user agent, referrer, coarse geo, device data. **Admin-only; shared configurable tracking retention, never public** |
| `board_reports` | Board report flow | `(message_id, reporter_key)` primary key, so one visitor cannot inflate a report count |
| `admin_credentials` | `/admin` sign-in | Exactly one row, `id = 1`. Stores only `hex(sha256(token))` |
| `board_paint_state` | `/community/board/` shared Paint canvas | One bounded drawing PNG, revision and editable sticker list |
| `board_paint_commits` | Paint publish retries | At most 128 recent request IDs for idempotency |
| `board_paint_activity` | Admin security/activity surface | Accepted publish summaries only; admin-only, shared configurable tracking retention, capped at 5,000 rows |
| `site_settings` | Dynamic site configuration | Dynamic key-value store for `/admin` → Configuration hot-swapping, including game/security raw tracking retention |
| `game_sessions` | Games & play admin view | Anonymous guest/game/run totals, bounded visible active time and private device/IP metadata |
| `game_scores` | Leaderboard foundation | Server-validated only, one guest-session personal best per game/mode, top 500 per mode |
| `game_players` | Optional global game identity | Opaque ID; recovery-code digest only; no email/password. `0013_names.sql` adds the nullable unique `handle` (`[a-z0-9_]{3,20}`) + `handle_changed_at` columns; existing rows untouched, NULL until claimed |
| `game_player_sessions` | Player authentication | Random session-token digests, expiry/revocation; FK cascade on delete |
| `game_auth_attempts` | Recovery-code sign-in throttling | Hashed IP only; bounded age cleanup |
| `game_saves` | Cross-device progress | Versioned JSON, ≤16 KiB/save, max 25 slots/player, revision CAS |
| `guest_profiles` | `/projects/games/` guest display names (chat plan Phase A) | One row per visitor session, keyed by `sha256(session id)`; display name only; swept hourly on a fixed 30-day window; no raw session values |
| `dm_conversations` | `/community/messages/` (chat plan Phase D) | One row per pair, id = `sha256([a,b].sort().join(':'))` over player IDs, canonical members + per-side read watermark; account lifetime |
| `dm_messages` | `/community/messages/` (chat plan Phase D) | Plain text + optional attachment id, monotone per-conversation sequence, `hidden_for` delete-for-me bits; swept hourly at `DM_CONFIG.retentionDays` (default 60 days) |
| `dm_attachments` | `/community/messages/` images (chat plan Phase D) | Base64 image bytes (≤1.4 MB decoded, sniffed PNG/JPEG/WebP), claimed by exactly one message; purged with the message or when an upload is never claimed |
| `dm_reports` | DM report flow (chat plan Phase D, plan §12.5) | Content snapshot at report time, hashed author/reporter, status open/resolved/dismissed; shared retention sweep |
| `dm_reporters` | DM report de-duplication | Distinct-report counting per conversation message, hashed reporter; with its report |

`0017_room_lobby_index.sql` adds **one index and nothing else**
(`idx_room_registry_game ON room_registry (game_id, expires_at)`) so the public
lobby listing seeks the registry instead of scanning it. Its header also records
the framing change that comes with the feature: `0014` treated the room code as
the thing keeping rooms private, and public listing supersedes that — the code
is now published by `GET /api/games/lobbies` (uncached, rate-limited, no
membership required), while never entering an index, a prerendered page, a URL,
a share link or an analytics event. Re-running it is a no-op; dropping it only
costs the listing a scan.

Migration `0004` added four columns to the existing `board_messages`:
`report_count`, `reported_at`, `status_note`, `moderated_at`. Migration `0006`
creates the bounded Paint snapshot and retry tables; migration `0007` adds the
sticker JSON column and private activity table. Neither modifies messages.

No existing board messages are modified. Existing rows get `report_count = 0`
and NULLs for the other three, which is correct — they have never been
reported or moderated.

---

## 3. Add the `ACCESS_SECRET`

Admin sessions are signed with this. **Without it, `/admin` and every
`/api/admin/*` route return `503`** — they fail closed on purpose rather than
opening up.

```bash
# generate a random value
openssl rand -hex 32

# store it (paste the value when prompted)
npx wrangler secret put ACCESS_SECRET
```

This value is never shown again. If you lose it, generate a new one and put it
again — it only invalidates existing admin sessions, it does not affect the
token.

You do **not** need `ACCESS_TOKEN` for `/admin`. The admin surface is gated by
the hashed credential in D1, not by that variable.

---

## 4. Deploy

Pushes to `main` build and deploy automatically through Cloudflare Workers
Builds. Pushes to other branches build **Workers Previews**, configured by the
`previews` block in `wrangler.json` — see CONFIGURATION.md §9.1 before
changing any binding. If you deploy by hand instead:

```bash
npm run build
npx wrangler deploy
```

---

## 5. Rotate the admin token — do this first

⚠️ **The token seeded by migration 0005 was supplied in the original build
request and is published in the handover notes. Anyone who read them can sign
in to `/admin` as you.**

1. Go to `/admin` and sign in with the seeded token.
2. Open **Settings → Access token**.
3. Enter a new one (at least 8 characters; longer is better).
4. Save.

Rotation is immediate: it invalidates every existing session and the old token
stops working. The panel then reports "rotated" instead of "seeded, never
rotated".

Do this the moment the deploy finishes. It is the only step on this page that
is not a no-op for an existing site.

---

## 6. Verify

```bash
# pages
curl -s -o /dev/null -w '%{http_code}\n' https://bnji.net/
curl -s -o /dev/null -w '%{http_code}\n' https://bnji.net/community/board/
curl -s -o /dev/null -w '%{http_code}\n' https://bnji.net/gizlyy/

# admin redirects an anonymous visitor to the login page
curl -s -o /dev/null -w '%{http_code}\n' https://bnji.net/admin

# the public API answers, and leaks no moderation fields
curl -s 'https://bnji.net/api/board?limit=1'
```

Then, in a browser:

- `/gizlyy/` shows a **view count**, not a dash. If you see `—` and
  "Counts are unavailable", the migration did not apply — go back to step 2.
- `/community/board/` loads, and you can still read existing messages.
- `/admin` signs in, and the dashboard loads stats.
- Deleting a board message removes it from the public feed; restoring brings
  it back. It is still delete-only, by design.

---

## 7. Local development

```bash
npm ci
npm run preview
```

`npm run preview` is one command and does the whole local flow: `astro build`,
then `wrangler d1 migrations apply bnji-board --local` (**pending migrations
only — already-applied ones are never rerun**), then `wrangler dev`. The
duplicate `bnji_board` remote binding was removed 2026-10-01
(CONFIGURATION.md §5.2), so no `--local` flag or `CLOUDFLARE_API_TOKEN` is
needed for local development anymore.

Create `.dev.vars` for local secrets. It is gitignored — never commit it.

```
ACCESS_SECRET=<any random string>
```

Prefer raw commands? `npx wrangler d1 migrations apply bnji-board --local`
then `npx wrangler dev --port 8788` is equivalent.

---

## 8. If something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/gizlyy/` shows `—` and "counts are unavailable" | `profile_views` missing | `npx wrangler d1 migrations apply bnji-board --remote` |
| `/admin` is `503` | `ACCESS_SECRET` not set | `npx wrangler secret put ACCESS_SECRET` |
| `/admin` is `401` with the right token | Token rotated, or row out of sync | `/api/admin/board` etc. need a session; sign in again. If the token is lost, reseed — see `docs/ADMIN.md` |
| Board page loads but posts fail `503 storage_unavailable` | `BOARD_DB` binding or DB missing | Check the binding id in `wrangler.json`, then re-apply migrations |
| `npx wrangler dev` demands a `CLOUDFLARE_API_TOKEN` | Stale checkout still carrying the old `bnji_board` remote binding | Pull current `wrangler.json` (the binding was deleted 2026-10-01, CONFIGURATION §5.2); a plain `npm run preview` is then fully local |
| Login says "too many attempts" | Rate limit: 10 failed attempts per 15 min per IP | Wait it out. It is a real limit, not a bug |
