# Data collection policy

**Adopted:** 2026-09-30 (America/Toronto) by owner decision. This document
supersedes the implicit posture in `docs/DATA.md` §9 and the Games decision
records that the site collects only what each existing feature strictly needed
and keeps new surfaces read-free of user content.

**Owner instruction that this policy implements:** the site may collect chat
history and comparable activity records; administrators may see and log
messages; surfaces such as the Paint canvas may be attributed and logged. This
document makes that permission explicit and attaches the conditions that keep
it honest.

## 1. The principle

**Collection is allowed.**

Any surface that stores user-submitted content or behaviour must have, in the
same commit that adds it:

1. a **register entry** in `docs/DATA.md` (fields, purpose, retention, who can
   read it, whether it is disclosed);
2. a **config value** (in `src/config/`) for its limits and retention, not a
   hard-coded constant;
3. a **plain-language line** on the public privacy page (`/privacy/`, planned —
   until it exists, the page hosting the feature must say what is stored).

This is the whole policy. Everything below is the detail.

## 2. What changes from the previous posture

| Surface | Before | Now |
| --- | --- | --- |
| Room chat | Recorded decision: "no chat history" | **Allowed — implemented (Phase B).** Bounded history is retained for the room's lifetime (≤2 h), survives reconnects, and is deleted with the room. Administrators may read it while the room exists (admin tooling **shipped with Phase C**: Chat tab, service-authenticated transcript, report snapshots + bans in D1; see `docs/CHAT-SYSTEM-PLAN.md`). |
| Message logging by admins | Not contemplated | **Allowed as a capability.** Each surface ships with a documented default and its own register entry. |
| Private messaging | Was a contact form relayed to Discord/ntfy | **Allowed.** Account-to-account messages, attachments and read state may be stored for a bounded retention window, with admin-readable moderation paths. |
| Paint canvas activity | Admin-visible and attributed to IP - stickers images may be stored and logged
| **Attribution allowed** (session, and optionally account, plus the action detail the owner chooses), with the caveats in §6. |
| Games telemetry | Private, coarse, bounded | Unchanged policy-wise; existing retention rules still apply. |
| Identity | Hashed credentials, Full IPs allowed |

## 3. What does not change

1. **Secrets never appear in the repository**, and credentials are stored as
   hashes/digests (admin token, player recovery codes, session tokens, hashed
   IPs). Opening up collection does not touch this.
2. **Public APIs stay minimal.** Whatever is stored, a public response exposes
   only what the feature needs — never internal IDs, session keys, player IDs
   or moderation metadata.
3. **Every store has a declared retention value.** "Infinite by omission" is
   not an acceptable outcome of this policy; an explicit "permanent" is a
   decision, recorded in the register.
4. **Admin access is authenticated and `no-store`.** No new public endpoint may
   read moderation or logging data.
5. **Rate-limit keys are not a logging surface.** KV keys stay short-lived
   (`docs/DATA.md` §4) unless a surface explicitly registers IP retention.

## 4. Retention requirements

- Every new table gets a retention value in `src/config/` and an entry in the
  register. Options: room-lifetime (chat in rooms), a bounded window (default
  suggestion: 60 days for messages — "not necessarily persistent forever"),
  permanent (opt-in only), not cascaded with account deletion.
- Deletion must be **reachable by code** — the hourly sweep
  (`src/server/tracking-retention.ts`) is the established mechanism; a table
  that can only be cleaned by a manual `wrangler d1 execute` is incomplete.
- **Account deletion must specify what it removes.** For room chat, Phase C
  resolved it: live room text is room-keyed and dies with the room (≤2 h),
  while every D1 row keyed to the principal (report snapshots, filed reports,
  bans, registry ownership) is swept by `deletePlayerAccount` and the export
  carries a `chatModeration` section — `chat_moderation_log` is kept as
  unlinkable-hash audit (documented, not silent). For DMs, deletion should
  tombstone the account's messages — the choice is a decision item for Phase D, not an accident.
- Retention values are admin-editable where the existing
  `trackingRetentionDays` pattern already applies; they are a product setting,
  not a legal guarantee.

## 5. Admin visibility rules

- **Rooms:** administrators may list active rooms and read a room's chat while
  it exists. Rooms already expire in ≤2 h, so this is bounded by design.
- **Private messages:** the register entry must state which of these is true
  for the deployment: metadata only (who, when, counts), content visible on
  report, or full content logging. All three are permitted; the default is a
  config value. It may be shown in the privacy page.
- **Paint/activity logs:** admin-only, `no-store`, and subject to the same
  retention sweep as other telemetry.
- Admin actions on user content (hide, delete, block) should themselves be
  logged — an audit trail for moderation is as valuable as the content log.

## 6. Paint canvas: what "attribution" may include

The previous guardrails excluded accounts, IPs, pointer paths, sticker images
and canvas contents. Under this policy the owner may extend the record; each
extension is a separate register line, and these are the honest trade-offs:

| Extension | Cost/risk |
| --- | --- |
| Account or guest-session attribution of publishes | Low. Makes abuse handling and "who painted this" answerable. |
| Per-action detail (what was drawn, where) | Moderate. The canvas is a creative surface; recording strokes or regions stores creative expression in a way publish counts do not. |
| Pointer paths / full edit replay | High. Several megabytes per session, high personal-content density, and a "we recorded everything you drew" surprise if undisclosed. Recommend against unless there is a specific need. |
| Sticker images / canvas snapshots | High storage and privacy weight. Recommend snapshots only for moderation evidence on report (see §5), not continuous logging. |
| IP retention beyond the transient rate-limit key | Already possible elsewhere (security events); keep it separate from Paint and disclose it there rather than duplicating IP storage per surface. |

## 7. Privacy obligations (unchanged by this policy)

These are the owner's obligations, not the implementation's preferences, and
the plan documents should keep saying so plainly:

- **PIPEDA / Quebec Law 25.** Collecting and storing user content, usernames,
  message logs and activity attribution makes the site a collector of personal
  information. That requires a clear privacy notice (what is collected, why,
  how long, who can see it), and a path to answer access/correction/deletion
  requests. The register in `docs/DATA.md` plus the `/privacy/` page is that
  notice; keeping them in sync is the actual compliance work.
- **Retention defaults are decisions, not compliance claims.** The existing
  wording in `docs/DATA.md` §9 ("a 60-day default is a product setting, not a
  claim of legal compliance") applies to everything added under this policy.
- **Third-party processors** (a mail provider, push service, or moderation API)
  need a register entry too, and their own terms.

## 8. What still needs an explicit decision record

Even under this policy, these get their own decision document because they are
hard to reverse or unusually invasive:

1. Full content logging of private (account-to-account) messages as a
   **default**, as opposed to a capability or a report-driven path. 
2. Recording pointer paths, canvas contents or other continuous behavioural
   capture.
