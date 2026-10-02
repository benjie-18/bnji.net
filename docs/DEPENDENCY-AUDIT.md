# Dependency audit: Games follow-up

**Checked:** 2026-09-29 (America/Toronto), Node 22 / npm 10.

> **Policy note (2026-09-30).** This document remains the audit record for
> production dependencies. The rule that produced it — "no new dependencies,
> lockfile frozen" — has been replaced by the tiered policy in
> [`DEPENDENCY-POLICY.md`](./DEPENDENCY-POLICY.md). New dependencies are
> permitted per tier; this file is updated in the same commit whenever a
> production dependency changes, and `npm audit` / `npm audit --omit=dev` are
> re-run after every change.

## Findings and reachability

The initial `npm audit` reported three moderate advisories and one high advisory:

| Package/version before remediation | Severity | Dependency path and reachability |
| --- | --- | --- |
| `@cloudflare/vite-plugin@1.54.8` | Moderate | Transitive from production-declared `@astrojs/cloudflare@14.3.1`. It is the Vite/Cloudflare build adapter, not code included in the deployed Worker request bundle. |
| `miniflare@5.20260910.0-alpha` / `5.20260911.0-alpha` | Moderate | Nested beneath the Cloudflare Vite plugin and Wrangler. Used to emulate Workers during build/local development; not part of deployed Worker request handling. |
| `undici@7.29.0` and `8.10.0` | High | `7.29.0` was nested under Miniflare; `8.10.0` was reached through `astro@7.3.2 → unifont@0.7.5`. These are Node-side tooling/build dependencies, not Worker-bundled request code. |
| `wrangler@4.131.0` | Moderate | Direct development dependency, used for local checks and deploy tooling only. |

`npm audit --omit=dev` initially returned the same findings because the Astro Cloudflare adapter and Astro themselves are declared production dependencies and carry build-time packages transitively. Therefore the advisories were **not accurately summarized as exclusively dev-only by npm's dependency classification**. Inspecting the adapter/build role and generated Worker output showed the vulnerable tooling was not bundled into the production request handler; in any case, the packages were updated rather than relying on that distinction.

## Remediation

Applied non-major, compatible dependency updates:

- Wrangler: `4.131.0 → 4.144.0` (same major; supports the adapter's declared peer range).
- Cloudflare Vite plugin: `1.54.8 → 1.62.2` through the adapter's existing semver range.
- Miniflare: `5.20260910/11.0-alpha → 5.20260926.1-alpha`.
- Undici: `7.29.0 → 7.29.1` and `8.10.0 → 8.11.2` through existing dependency ranges.
- Added the specifically requested development test packages: `@playwright/test@1.63.0` and `@axe-core/playwright@4.13.0`.

No `--force` audit fix or major-version override was used. Lockfile resolution was tested with the repository build/check gate. Current results:

```text
npm audit             0 vulnerabilities
npm audit --omit=dev  0 vulnerabilities
```

Re-run these commands after dependency changes; advisory databases and package versions change over time.

## Chat harness addition: Vitest Workers pool (2026-09-30)

**Checked:** 2026-09-30 (America/Toronto), Node 22 / npm 11 (the lockfile is
regenerated with npm 11: npm 10.9.8 resolves the vitest 4 peer graph
differently, and each major writes package placement the other's `npm ci`
rejects — see "Workers Builds lockfile repair" below).

Added as **Tier A dev-only** dependencies per
[`DEPENDENCY-POLICY.md`](./DEPENDENCY-POLICY.md) §5 (the plan's recommended
harness, [`CHAT-SYSTEM-PLAN.md`](./CHAT-SYSTEM-PLAN.md) §13):

- `vitest@4.1.11` (pinned to the pool's `^4.1.0` peer range),
- `@cloudflare/vitest-pool-workers@0.22.0`.

Neither ships to browsers or the deployed Worker: `wrangler deploy --dry-run`
reports `Total Upload: 1091.09 KiB / gzip: 277.16 KiB` — byte-identical to the
baseline recorded in [`DEPENDENCY-POLICY.md`](./DEPENDENCY-POLICY.md) §4.

The pool pins `miniflare`/`wrangler` as hard dependencies at versions whose
transitive `sharp` (< 0.35.4) and `undici` (≤ 7.29.0) advisories npm flagged.
Rather than accept five dev-only highs or `audit fix --force` (which would have
downgraded the pool to 0.8.30), `package.json` scopes an `overrides` entry to
the `@cloudflare/vitest-pool-workers` subtree only — `miniflare` 5.20260930.0-alpha
(whose own `sharp` 0.35.4 / `undici` 7.29.1 are clean), plus `sharp` 0.35.4 and
`undici` 7.29.1 — so the production Wrangler/Astro toolchain keeps its own
pinned versions. The Worker runtime used by the tests is workerd 1.20260930.2
with `compatibility_date` 2026-09-14, matching production.

Install scripts follow the repository's `allowScripts` list; the new entries
(`esbuild@0.25.12`, `esbuild@0.28.1`, `workerd@1.20260815.1`,
`workerd@1.20260926.1`, `workerd@1.20260930.2`) are the exact versions in the
lockfile. Current results:

```text
npm audit             0 vulnerabilities
npm audit --omit=dev  0 vulnerabilities
```

## Lockfile repair and audit refresh (2026-10-02)

> Run with npm 10, and superseded the next day — see "Workers Builds lockfile
> repair" below. The `devalue` refresh it made is kept; its package placement
> is not.

A clean `npm ci` initially failed because the lockfile omitted the Cloudflare
adapter's `esbuild@0.28.2` package and optional platform records. Refreshing the
lockfile restored those records and removed a stale nested `jsdom`/`undici`
entry; `package.json` is unchanged. The same fresh audit identified a newly
advisory-affected transitive Astro dependency, so `npm audit fix
--package-lock-only` updated `devalue` from `5.9.1` to `5.9.4` within its
existing semver range. No direct dependency or override changed.

Verified with a clean `npm ci`, the full test suite, and `npm run check`:

```text
npm audit             0 vulnerabilities
npm audit --omit=dev  0 vulnerabilities
```

## Workers Builds lockfile repair (2026-10-02)

The Workers Builds deploy failed at the install step:

    Installing project dependencies: npm clean-install --progress=false
    npm error code EUSAGE
    npm error `npm ci` can only install packages when your package.json and
    package-lock.json or npm-shrinkwrap.json are in sync.
    npm error Missing: undici@7.29.1 from lock file

Cause: the "Lockfile repair and audit refresh" above was written with **npm 10**,
while Workers Builds runs Node 24, whose npm is **11.x** (the build log's option
list — `--allow-directory`, `--allow-file`, `--allow-git`, `--allow-remote`,
`--allow-scripts` — and the `Missing: … from lock file` line are npm 11). The
two majors resolve this graph's vitest 4 / `vite`-peer tree differently, and
each rejects the other's package placement:

- npm 10 writes an `@astrojs/cloudflare` → nested `esbuild@0.28.2` tree (plus 26
  platform records) and drops `node_modules/jsdom/node_modules/undici@7.29.1`,
  which the `@cloudflare/vitest-pool-workers` override requires. npm 11's
  `npm ci` then fails with `Missing: undici@7.29.1 from lock file` — the
  production deploy error.
- npm 11 drops that nested esbuild tree; npm 10's `npm ci` then fails with
  `Missing: esbuild@0.28.2 from lock file` (what the repair above was reacting
  to).

Fix: `package-lock.json` regenerated with npm 11.21 (`npm install
--package-lock-only`); `package.json` is unchanged, and the `devalue` 5.9.1 →
5.9.4 refresh from the previous repair is preserved. The lockfile again records
`node_modules/jsdom/node_modules/undici@7.29.1` and no nested adapter esbuild.

**Rule from here on: regenerate the lockfile with npm 11 (the npm that ships
with Node 24, which Workers Builds uses) and confirm `npm ci` exits 0 before
committing.** npm 10 does not error locally; it silently rewrites package
placement into a shape the deploy rejects.

Verified after the repair:

```text
npm ci (npm 11.21.0, reproduced the failure before the fix)  exit 0, 329 packages
npm ci (npm 12.2.0)                                         exit 0
clean npm ci → npm run check → npm test                     all green (49 tests,
                                                            Total Upload 1367.79 KiB / gzip 339.66 KiB)
npm audit                                                   0 vulnerabilities
npm audit --omit=dev                                        0 vulnerabilities
```
