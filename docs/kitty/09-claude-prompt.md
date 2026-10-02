# Claude Prompt — Kitty Factory Implementation

Copy-paste this to Claude Fable 5.1 (or Sonnet) after pointing it at `docs/kitty/` folder.

---

**Prompt:**

You are building Kitty Factory for bnji.net, an Astro 7 + Cloudflare Workers Free site. Read docs/kitty/ in order: 00-overview.md, 03-implementation-plan.md, 04-data-schema.md, 05-architecture.md.

Constraints (non-negotiable):
- Free-only: Three.js 0.160.0 MIT + Kenney CC0 + Quaternius CC0, no paid services, no R2, no PlayFab
- Integrated: bnji.kitty-factory at /games/kitty-factory/, uses existing GameShell, mountGameLifecycle, mountGameSession, game_saves (25 slots ×16KiB, revision CAS, IndexedDB queue), leaderboard verifier pattern
- Saves: local IndexedDB every 10s, cloud every 2 min throttled + manual debounced 5s + prestige events, compact <16KiB for 100 machines, offline progress capped 2h via lastSeenAt
- D1 Free 100k writes/day shared — low DAU <50 makes frequent saves viable (~37k/day for 20 DAU). Must NOT use KV for saves
- Data-driven: all content in src/data/kitty-content.ts, adding machine = 1 config entry + 1 GLB in public/games/kitty/
- Low-poly 3D hybrid: third-person orbit default (OrbitControls), top-down build mode, optional first-person inspect (PointerLock on double-click). InstancedMesh per machine type, instanced kitties, belt UV scroll shader, pollution fog
- Description ≤12 words, ID stable bnji.kitty-factory, capabilities ['keyboard','pointer','touch','webgl','audio'], modes ['default'] bestValue
- Verifier in src/server/game-adapters/kitty-factory.ts, import in register-all.ts, add to SCORE_VERIFIER_GAMES in game-adapters.ts, else 503 outage and test fails
- No new D1 migration, no new secrets, no new bindings

Follow phases in 08-checklist.md, do NOT do full implementation in one go. Start Phase 0 scaffolding only:

Phase 0 tasks:
1. Add three@^0.160.0 to package.json, document justification in docs/GAMES-DECISIONS.md (Tier 2 runtime dep)
2. Create src/data/kitty-content.ts with MACHINES (5 MVP: mom, hatchery, artist, printer, adoption), KITTY_COLORS, TRAITS, RACES, FACTORY_TYPES, LOCATIONS, ACCESSORIES, PARCEL_COST, PRESTIGE per 04-data-schema.md
3. Create src/game/kitty-formulas.ts with all formulas
4. Create src/game/kitty-save.ts with SAVE_VERSION=1, createNewSave(), migrate(), compactEncode/Decode, offlineProgress()
5. Create src/pages/games/kitty-factory.astro with GameShell, canvas data-kitty-canvas, UI overlay, minimap, manual save button, leaderboardHref
6. Create src/scripts/games/kitty-factory.ts with Three.js dynamic import, scene ground + orbit, fitCanvas DPR handling, mountGameLifecycle pause/resume, mountGameSession, local save every 10s, cloud throttled 2min, manual save, offline calc
7. Create src/server/game-adapters/kitty-factory.ts verifier skeleton returning score=bestValue if plausible
8. Update src/data/games.ts add bnji.kitty-factory entry status in-development, description ≤12 words
9. Update src/data/game-adapters.ts add bnji.kitty-factory to SCORE_VERIFIER_GAMES
10. Update src/server/game-adapters/register-all.ts import './kitty-factory'
11. Add public/games/kitty/ folder with placeholder GLB (use box geometry if no GLB yet)
12. Verify: npm run build passes, tsc --noEmit 0 errors, save size <16KiB

After Phase 0 passes verification checklist in 08-checklist.md, proceed to Phase 1 MVP Core Loop per implementation plan.

Do not implement full game in one go. Phased, verified.

---

**For full context, also read:**
- 01-research-hosting-2d-vs-3d.md
- 02-lowpoly-3d-first-third-person.md
- 06-asset-pipeline.md
- 07-update-guide.md
- 10-one-shot-feasibility.md

