# Deploying an update to bnji.net

This is the owner-facing runbook. It answers one question: *after I pull, what
do I have to do?*

For the shared Paint canvas, the short version is: **if you already have the
D1 database, apply the new migration.** No new database, bucket, secret or
binding is required. The migration command is safe to re-run; D1 applies only
what is missing.

---

## 0. What actually changed in this update

| Area | Change | You must act? |
| --- | --- | --- |
| D1 schema | Paint adds `0007_paint_stickers_activity.sql` to the existing `bnji-board` schema | **Yes** — run `migrations apply` |
| KV namespace | Unchanged | No |
| D1 binding | Unchanged | No |
| Admin credential | New `admin_credentials` table, seeded by migration 0005 | **Yes** — rotate the token |
| `ACCESS_SECRET` | Now required for `/admin` to work at all | **Yes** — add the secret |
| Public pages | None | No |

Nothing in this update creates a second database, a second namespace, or a
bucket. The storage model is unchanged: one D1 database, one KV namespace.

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

Expected output — any unapplied migrations, including `0007_paint_stickers_activity.sql`; on a database already current with shared Paint, the only new entry is `0007_paint_stickers_activity.sql`:

```
┌──────────────────────────────────────┐
│ Name                                 │
├──────────────────────────────────────┤
│ 0002_profiles.sql                    │
│ 0003_security_events.sql              │
│ 0004_board_moderation.sql             │
│ 0005_admin_credentials.sql            │
│ 0006_board_paint.sql                  │
│ 0007_paint_stickers_activity.sql      │
│ 0009_site_settings.sql                │
└──────────────────────────────────────┘
```

If you see `0001_board_messages.sql` in that list, your database was never
migrated — run it, it is `CREATE TABLE IF NOT EXISTS` and will not harm
existing data.

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
| `security_events` | Abuse detection | IP, user agent, referrer, coarse geo, device data. **Admin-only, 60-day retention, never in any public response** |
| `board_reports` | Board report flow | `(message_id, reporter_key)` primary key, so one visitor cannot inflate a report count |
| `admin_credentials` | `/admin` sign-in | Exactly one row, `id = 1`. Stores only `hex(sha256(token))` |
| `board_paint_state` | `/board/` shared Paint canvas | One bounded drawing PNG, revision and editable sticker list |
| `board_paint_commits` | Paint publish retries | At most 128 recent request IDs for idempotency |
| `board_paint_activity` | Admin security/activity surface | Accepted publish summaries only; admin-only, 60-day retention, capped at 5,000 rows |
| `site_settings` | Dynamic site configuration | Dynamic key-value store for `/admin` → Configuration hot-swapping |

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
`wrangler.json`; see CONFIGURATION.md §5.2. Removing that binding is the
permanent fix and touches no application code.

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
