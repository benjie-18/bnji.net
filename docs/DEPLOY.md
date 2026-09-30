# Deploying an update to bnji.net

This is the owner-facing runbook. It answers one question: *after I pull, what
do I have to do?*

The Games foundation has additive D1 migrations `0011_games.sql` (tracking/scores) and `0012_game_players_saves.sql` (players/sessions/auth throttling/saves), an hourly retention Cron Trigger, and a new SQLite Durable Object class (`GameRoom`) for generic rooms. It reuses the existing D1/KV; there is no new database, bucket, secret, third-party service, or credential to provision. For the full current Games rollout checklist, quotas, local
Worker testing, and rollback notes, see [`GAMES-OPERATIONS.md`](./GAMES-OPERATIONS.md).
The migration command is safe to re-run; D1 applies only what is missing.

---

## 0. Current Games rollout

| Area | Change | Owner action |
| --- | --- | --- |
| D1 | Additive migrations `0011_games.sql` (sessions/scores) and `0012_game_players_saves.sql` (players, digested sessions, hashed-IP auth limits, bounded saves) | Apply only pending migrations to existing `bnji-board` after backup |
| Worker / Durable Objects | Astro HTTP handler, hourly retention Cron, SQLite class `GameRoom` under Wrangler migration `game-rooms-v1` | Deploy `src/worker.ts`; Wrangler applies the new class migration; confirm trigger and binding |
| Admin | Games & play view and configurable raw tracking retention | No new credential; existing `/admin` guard applies |
| Secrets/resources | No new binding, paid product, third-party service, or secret | None |

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

The unapplied list depends on the database's migration history. If it is already current through `0010_secret_code_uses.sql`, it should list `0011_games.sql` and `0012_game_players_saves.sql` (unless `0011` was applied earlier). Review the list before continuing. If legacy migrations also
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
| `board_paint_state` | `/board/` shared Paint canvas | One bounded drawing PNG, revision and editable sticker list |
| `board_paint_commits` | Paint publish retries | At most 128 recent request IDs for idempotency |
| `board_paint_activity` | Admin security/activity surface | Accepted publish summaries only; admin-only, shared configurable tracking retention, capped at 5,000 rows |
| `site_settings` | Dynamic site configuration | Dynamic key-value store for `/admin` → Configuration hot-swapping, including game/security raw tracking retention |
| `game_sessions` | Games & play admin view | Anonymous guest/game/run totals, bounded visible active time and private device/IP metadata |
| `game_scores` | Leaderboard foundation | Server-validated only, one guest-session personal best per game/mode, top 500 per mode |
| `game_players` | Optional global game identity | Opaque ID; recovery-code digest only; no email/password |
| `game_player_sessions` | Player authentication | Random session-token digests, expiry/revocation; FK cascade on delete |
| `game_auth_attempts` | Recovery-code sign-in throttling | Hashed IP only; bounded age cleanup |
| `game_saves` | Cross-device progress | Versioned JSON, ≤16 KiB/save, max 25 slots/player, revision CAS |

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
Builds. If you deploy by hand instead:

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
curl -s -o /dev/null -w '%{http_code}\n' https://bnji.net/board/
curl -s -o /dev/null -w '%{http_code}\n' https://bnji.net/gizlyy/

# admin redirects an anonymous visitor to the login page
curl -s -o /dev/null -w '%{http_code}\n' https://bnji.net/admin

# the public API answers, and leaks no moderation fields
curl -s 'https://bnji.net/api/board?limit=1'
```

Then, in a browser:

- `/gizlyy/` shows a **view count**, not a dash. If you see `—` and
  "Counts are unavailable", the migration did not apply — go back to step 2.
- `/board/` loads, and you can still read existing messages.
- `/admin` signs in, and the dashboard loads stats.
- Deleting a board message removes it from the public feed; restoring brings
  it back. It is still delete-only, by design.

---

## 7. Local development

```bash
npm ci
npx wrangler d1 migrations apply bnji-board --local
npx wrangler dev --local --port 8788
```

Create `.dev.vars` for local secrets. It is gitignored — never commit it.

```
ACCESS_SECRET=<any random string>
```

`--local` is required while the duplicate `bnji_board` binding exists in
`wrangler.json`; see CONFIGURATION.md §5.2. Use `--local` for local development and never let a local command target the remote `bnji_board` binding.

---

## 8. If something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/gizlyy/` shows `—` and "counts are unavailable" | `profile_views` missing | `npx wrangler d1 migrations apply bnji-board --remote` |
| `/admin` is `503` | `ACCESS_SECRET` not set | `npx wrangler secret put ACCESS_SECRET` |
| `/admin` is `401` with the right token | Token rotated, or row out of sync | `/api/admin/board` etc. need a session; sign in again. If the token is lost, reseed — see `docs/ADMIN.md` |
| Board page loads but posts fail `503 storage_unavailable` | `BOARD_DB` binding or DB missing | Check the binding id in `wrangler.json`, then re-apply migrations |
| `npx wrangler dev` demands a `CLOUDFLARE_API_TOKEN` | The `bnji_board` remote binding | Add `--local`, or delete that binding block |
| Login says "too many attempts" | Rate limit: 10 failed attempts per 15 min per IP | Wait it out. It is a real limit, not a bug |
