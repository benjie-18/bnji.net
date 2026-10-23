# Kitty Factory — Verification Checklist & Testing & Deployment

## 8.1 Verification Before Submit

- [ ] `npm run build` passes, `verify-access.mjs` OK — 2 rule(s), no protected route served statically
- [ ] `tsc --noEmit` 0 errors
- [ ] `SCORE_VERIFIER_GAMES` in `src/data/game-adapters.ts` includes `bnji.kitty-factory`
- [ ] `src/server/game-adapters/register-all.ts` imports `./kitty-factory`
- [ ] `src/data/games.ts` entry description ≤12 words, ID `bnji.kitty-factory`, href `/projects/games/kitty-factory/`, capabilities includes webgl
- [ ] Save size <16KiB for 100 machines (unit test)
- [ ] D1 write math: 50 DAU saving every 2 min = 42.5k/day <100k
- [ ] WebGL context lost handled (listen `webglcontextlost`, pause, fallback)
- [ ] Mobile touch tested (orbit one finger rotate, two finger zoom/pan, long press place)
- [ ] Leaderboard page `/projects/games/kitty-factory/leaderboard/` prerenders (from hasLeaderboard)
- [ ] No new secrets, no paid deps, Three.js MIT justified in GAMES-DECISIONS.md
- [ ] GameShell lifecycle pause/resume stops RAF
- [ ] Manual save debounced 5s, auto 2min throttled, local 10s
- [ ] Offline progress capped 2h
- [ ] No `example.com` or `localhost` in dist/client (grep)

## 8.2 Testing Plan

**Unit (vitest):**
- `src/game/kitty-rules.test.ts`: machine cost, pollution efficiency, kitty value, prestige formulas, synergy detection
- `src/game/kitty-save.test.ts`: migrate v1→v2, compact encode/decode size <16KiB, offline calc
- `src/server/game-adapters/kitty-factory.test.ts`: verifier plausible check, cheat rejection

**Workerd:**
- `npm run test:do` — existing DO tests

**E2E (Playwright):**
- `npm run test:e2e` — 390px mobile, 768px tablet, 1440px desktop, axe scans, keyboard-only, reduced motion, JS disabled
- Add test for `/projects/games/kitty-factory/` loads, canvas exists, build button clickable, save button works, leaderboard link exists

**Manual:**
- `npm run preview` → `wrangler d1 migrations apply bnji-board --local` → `wrangler dev`
- Test save every 2 min, manual save, conflict prompt, offline (close tab wait reopen)
- Test WebGL context lost via `WEBGL_lose_context` extension
- Test potato mode toggle, sound toggle, reduced motion
- Test prestige layers, parcel expansion, pollution visual

**Score verifier registry:**
- `tests/score-verifier-registry.test.ts` must pass — ensures no outage

## 8.3 Deployment

1. `npm install three@^0.160.0` (MIT)
2. Add game entry status `in-development`
3. Create files per 05-architecture.md
4. `npm run build` → verify-access OK
5. `npx wrangler d1 migrations list bnji-board --local` — no new migration
6. `npm run preview` manual test
7. `git push origin arena/01a0fe13-bnji-net` → PR → merge to main → Cloudflare Workers Builds auto deploys
8. Verify `/projects/games/kitty-factory/` loads, `/api/games/saves` works, leaderboard page exists
9. Set status to `available` when ready
10. Optional: add Cloudflare Route `kitty.bnji.net/*` → same Worker for vanity URL

No new secrets, no new D1, no new KV, no new DO.

## 8.4 Phases

**Phase 0 Scaffolding (1 day):** catalog entry, empty Astro page GameShell, Three.js ground + orbit, save schema v1, local save 10s

**Phase 1 MVP Core (1 week):** 5 machines, grid placement, manual drag + conveyor, pollution, money, money/s, kitties/s, efficiency HUD, parcel buy 1→2, save/load, offline, manual save

**Phase 2 Prestige + Content (1 week):** Rebirth, Evolution, Kitception, Factory reset, Move out, 12 machines full, synergies, parcel upgrades

**Phase 3 Polish + 3D (1 week):** InstancedMesh, belt shader, fog, minimap, achievements, accessories gacha, sound, potato mode, mobile, verifier, leaderboard

**Phase 4 Testing + Launch (2 days):** unit, e2e, manual, build verification, status available, deploy

Total ~3 weeks AI-assisted.

