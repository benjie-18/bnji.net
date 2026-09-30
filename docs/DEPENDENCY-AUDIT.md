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
