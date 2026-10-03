# Dependency policy

**Adopted:** 2026-09-30 (America/Toronto) by owner decision. **Supersedes** the
blanket "no new dependencies, lockfile frozen" rule that `AGENTS.md` §1.1
carried until this date.

This file is the authority on what may be added, how it is reviewed, and what
each tier costs. `docs/DEPENDENCY-AUDIT.md` remains the audit record for
production dependencies; `AGENTS.md` states the rule; this document explains it.

## 1. The rule in one line

**Adding a dependency is allowed and expected when it earns its place; adding
one silently is not.** The previous freeze was a proxy for "review this
deliberately". We keep the review and drop the freeze.

## 2. Tiers

| Tier | What it means | Examples | What it needs |
| --- | --- | --- | --- |
| **A — dev-only** | Never bundled into the deployed Worker or shipped to browsers | `vitest`, `@cloudflare/vitest-pool-workers`, `@axe-core/playwright`, bundle analysers, linters, Playwright | Routine. Commit `package.json` + lockfile together. Verify with `wrangler deploy --dry-run` that the deployed size did not move. |
| **B — runtime, invisible to visitors** | Runs in the Worker; adds nothing to the browser bundle | validation (`zod` / `valibot`), crypto/encoding helpers, date handling, parsers | The commit message (or a short note in the audit doc) states: what it replaces, its bundle cost, its failure mode, and why hand-rolling is worse. |
| **C — visitor-facing** | Ships to the browser, or changes the UI/architecture model | UI frameworks, editors, `three.js`, `phaser`, `yjs`, markdown/rich-text renderers | A decision record under `docs/` plus a measured budget: what it adds to the first paint of the page it lands on, and how it is code-split. |

Tier is decided by **where the code runs**, not by who wrote it. A tiny
validator that runs in the browser is Tier C; a large library that only ever
runs in the Worker is Tier B.

## 3. Non-negotiables that survive this policy

These were the useful parts of the old rule and are unchanged:

1. **Commit the lockfile with the manifest.** Never `npm install` in a
   CI-like environment without committing the resulting `package-lock.json`.
2. **`npm audit` stays clean for production dependencies.** Follow the standing
   process in `docs/DEPENDENCY-AUDIT.md`; re-run `npm audit` and
   `npm audit --omit=dev` after any change. `npm audit` is not the whole
   picture: the registry endpoint can lag the GitHub Advisory Database that
   Dependabot reads, so a clean audit does not close an open alert. When a push
   reports an alert `npm audit` cannot see, cross-reference the locked versions
   against the advisory database — the method and the one current example
   (alert #62, `http-cache-semantics`, no patched version, not reachable from
   the deployed Worker) are recorded in `docs/DEPENDENCY-AUDIT.md`.
3. **No secrets in `package.json`, code, docs or commit messages.** Secrets
   remain environment-only (`src/server/env.ts`, `astro.config.mjs` schema).
4. **A dependency is not a licence to skip the design work.** A library that
   would introduce background persistence, telemetry, or hidden network calls
   is a data-collection decision as well — see
   `docs/DATA-COLLECTION-POLICY.md`.
5. **Install scripts stay explicit.** `package.json`'s `allowScripts` list is
   deliberate: a new package with a postinstall step does nothing until it is
   added there. Check before assuming an install "just works".

## 4. Review process

```bash
npm install <pkg>              # or npm ci after pulling; commits manifest + lockfile
npm audit --omit=dev
npm test                       # behaviour suite
npm run check                  # build + access verification + tsc + wrangler dry-run
```

Then:

1. Read the `Total Upload` line from the dry run. Record it if the package
   could reach the deployed bundle. **Baseline measured 2026-09-30 on this
   repository, before any dependency was added:** `Total Upload: 1091.09 KiB /
   gzip: 277.16 KiB`, 79 modules — so a Tier B addition has roughly 63 MiB of
   headroom against the current platform ceiling and no realistic size problem.
   CPU time, not size, is the constraint that bites.
2. Update `docs/DEPENDENCY-AUDIT.md` when a **production** dependency changes.
3. For Tier C, write the decision record **before** the implementation lands.
4. Re-check the plan limits that actually constrain this repo: 10 ms CPU per
   invocation on Workers Free, 128 MB memory, 1-second startup, 100,000
   requests/day, and the shared D1/KV/DO allowances. Bundle size stopped being
   an architectural gate; CPU time and quotas did not.

### Recommended next step: make the gate real

There is still **no CI** in this repository (`.github/` contains only
Dependabot configuration). Every gate in §4 is run by a human remembering to
run it. The single highest-value change available before adding anything is a
workflow that runs `npm ci && npm run check && npm test` on pull requests. It
is a new file, not a dependency.

## 5. What dependencies actually unlock here

| Want | Tier | Package(s) | Honest assessment |
| --- | --- | --- | --- |
| Test real Durable Object behaviour (hibernation, `getWebSockets()`, DO SQLite, D1 inside `workerd`) | A | `vitest` + `@cloudflare/vitest-pool-workers` | **Highest value.** `tests/support/` currently cannot even import `src/server/game-room-do.ts`. This buys platform-faithful tests for the least-covered, highest-risk code in the repo. Cost: a second test runner beside `node:test`. |
| Payload validation across API routes | B | `zod` (large-ish) or `valibot` (small) | Reasonable, low urgency. Existing checks are careful and individually tested; the win is consistency on future routes. Prefer the small one. |
| CRDT multiplayer state (co-op games, shared documents) | C | `yjs` + provider | The genuine unlock for multiplayer beyond opaque state. It supersedes the current CAS/authority design, so it is an architecture decision wearing a library costume — do it deliberately or not at all. |
| Room/lobby framework on Durable Objects | C | `partyserver`-style | **Skip.** The repo already has a working, documented room object with hibernation, membership, host handoff and CAS. Adopting a framework would rewrite working code for routing sugar. |
| 3D / game engines / audio | C | `three`, `phaser`, `matter-js`, `howler` | Viable now that bundle ceilings are generous, **if** dynamically imported on the pages that need them (the `game-runtime.ts` pattern). The constraint is the visitor's first paint, not Cloudflare. |
| Image processing (resize, EXIF strip, re-encode) in the Worker | B | `@jsquash/*` (WASM), `sharp` alternatives | Relevant to private-messaging image support. WASM decode on a 10 ms CPU budget is a real risk — prefer client-side canvas normalisation plus server-side magic-byte and size validation. |
| Markdown / rich text rendering for chat | C | `marked`, `micromark` | **Avoid for user-generated chat.** Plain text rendered with `textContent` is the existing house rule and the smallest XSS surface. |

## 6. Infrastructure beyond npm

These are bindings and products, not packages, and are now permitted under the
same deliberate-change standard as `AGENTS.md` §1.2 — with a **separate
documented decision each**, because they cost money, storage or compliance
surface rather than bundle size:

| Change | Unlocks | Cost/risk to check |
| --- | --- | --- |
| **R2 bucket** | Private-message image storage; lifting the board's ~1.4 MB image ceiling | Cloudflare's R2 pricing page lists a free tier of 10 GB-month storage, 1M Class A + 10M Class B operations/month and free egress (checked 2026-09-30). Two things are **unverified and must be confirmed in the dashboard before this design is committed**: whether an R2 binding is usable from a Workers Free account, and whether enabling R2 requires a payment method on file. Third-party sources conflict on the first and claim the second. Keep the D1-stored-image fallback (the board's proven path) until confirmed. |
| **D1** (existing `BOARD_DB`) | Chat history, DM messages, friend graph, moderation queues | Rows read/written are hard-capped on Free (5M / 100k per day, shared account-wide). Chat is the first feature whose natural write rate can approach those caps. |
| **Durable Objects** (existing SQLite class pattern) | Per-conversation live delivery, presence, room chat | 100k DO requests/day, 100k SQLite rows written/day, 5 GB storage on Free, shared account-wide. |
| **Workers Paid ($5/mo)** | Higher Worker/DO/CPU ceilings; possibly R2 binding | A budget decision for the owner, not a technical blocker. If adopted, record it in `docs/DEPLOY.md` and update the quota sections of `GAMES-OPERATIONS.md` and the chat plan. |
| **New secrets / third-party services** | Anything OAuth-, push- or provider-based | Still needs a config entry, a secret in the environment, and a data-collection register entry. |

## 7. Rollback of this policy

If a dependency turns out to be a mistake, the cost is a revert commit plus a
`npm ci` — the lockfile is the rollback. That is materially cheaper than the
alternative the freeze encouraged: hand-rolling a large amount of
security-sensitive, under-tested code to avoid a review. That trade is the
reason for this change.
