# Kitty Factory — Hosting & Tech Research

**Date:** 2026-10-02  
**Status:** Research only, no implementation  
**Scope:** Can it live on existing `bnji.net` games infra vs `kitty.bnji.net` subdomain, 2D indie vs 3D Roblox-style difficulty with AI, free-only options.

---

## 1. Executive Summary

Kitty Factory is a **tycoon incremental idle** game heavily inspired by Roblox's **Sell Lemons** (BloxByte Games). Sell Lemons loop is:

- Buy income sources (Lemon Stand → LemonDash → ... → LemonX) with cash upgrades & speed upgrades, managers automate.
- Reset layers: **Rebirth** (lose cash/sources, keep some upgrades, gain Investors/Powers), **Evolution** (fruit tier 0-9 loops with +1, x42 global speed per tier, requires total Investors including spent), **Ascension** etc.
- Stargate/World Reactor late-game energy sink.

Kitty Factory maps 1:1:
- Income Sources → kitty machines (mom, hatchery, artist, chef, printer, sculptor, vending, bakery, plushie, 3D printer, robot assembler...)
- Rebirth → treats (kitties produced → currency)
- Evolution → super treats + kitty color rarity (0=black 1=brown 5=white 10=orange...)
- Traits/size → colossal scaling (tiny → godlike)
- Kitception → race change (Persian → alien anthropomorphic) = incredible treats
- Factory reset → factory type (garage → industrial complex) = factory credits
- Move out → location (village → different planets)

**Verdict:** Existing infra **can fully host it** as `bnji.kitty-factory` under `/games/kitty-factory/` with zero paid services. Subdomain `kitty.bnji.net` is technically possible free, but adds operational overhead and only justified if you want isolation for bundle size / separate tech stack / marketing.

2D indie style is **~3-4x easier** to ship with AI than 3D Roblox style on free stack.

---

## 2. Existing Games Infrastructure Audit

From `src/data/games.ts`, `wrangler.json`, `GAMES-DECISIONS.md`, `GAMES-OPERATIONS.md`:

**Stack:**
- Astro 7 + `@astrojs/cloudflare` 14.3.1 → Cloudflare Workers (Free: 100k req/day, 10ms CPU)
- D1 `bnji-board` (BOARD_DB): 5M rows read/day, 100k rows written/day, 5GB/account, 500MB/DB
- KV `BOARD_KV`: 100k reads/day, 1k writes/day, 1k deletes/day
- Durable Objects: `GAME_ROOMS`, `DM_CONVERSATIONS`, `PRESENCE` (SQLite-backed). Free: 100k DO req/day, 13k GB-s, 5M SQLite reads/day, 100k writes/day, 5GB total. Hibernating WS free.
- Cron `0 * * * *` hourly retention sweep (5 max slots on Free, 1 used)
- Worker entry `src/worker.ts` forwards to Astro handler + scheduled sweep

**Game system:**
- Catalog `defineGameCatalog` with stable IDs `bnji.<kebab>`. Never rename after scores exist. 12-word description limit.
- `GameShell.astro` chrome: instructions, pause/resume, fullscreen toggle, leaderboard link, lifecycle events `bnji:game-pause/resume`
- `mountGameLifecycle(root, module)` + `mountGameSession(root, gameId)`: visibility pause, heartbeat 1/min, idle stop after 2min, 45s min heartbeat interval server-side, 65s clamp
- Saves: `game_saves` table, per player max 25 slots × 16 KiB JSON each, revision CAS, IndexedDB pending queue with 3 retries, offline support, conflict prompt
- Scores: `game_scores`, one best per session/game/mode, top 500/mode retained, server verifier required (`registerScoreVerifier`). `SCORE_VERIFIER_GAMES` list controls leaderboard pages. Fail-closed `503 verifier_unavailable` if missing. Verifiers in `src/server/game-adapters/*` imported via `register-all.ts`
- Leaderboards: `/games/<slug>/leaderboard/` static prerendered, 25 rows/page, 20 pages, label composed at read time from `handle · Display Name` (no migration)
- Rooms: generic `GameRoom` DO per 128-bit code, 8 members, 4 KiB msg, 3 KiB state, 1 state write/5s/room, 8 frames/s abuse ceiling, 2h expiry. Optional authority + action handler + redactor. Chat lives in DO SQLite, 200 rows cap.
- Player identity: optional global account, 160-bit recovery code shown once, SHA-256 stored, 256-bit session token in HttpOnly cookie, `bnji_ps` guest cookie. Guest display names in `guest_profiles` (30d). Handles `[a-z0-9_]{3,20}` unique, cooldown.
- Admin: `/admin` with Games & play totals, tracking retention config (default 60d, 1-365), chat moderation tab, player blocks, etc.
- Frontend games: `src/scripts/games/{stack,chess,pvp-minesweeper}.ts` + `src/game/*-rules.ts` shared engine. Stack example: rules owned by `stack-rules.ts`, renderer uses quantized positions, proof submitted, server replays.

**Free budget reality check (from GAMES-OPERATIONS.md):**
- At 100 DAU × 2h visible = ~12k heartbeat D1 writes/day + retention sweep ~33k writes/day (50 primary +10 catch-up per table/hour) = ~69k writes/day leaving ~30k for saves/accounts/scores. Save spam eats budget.
- KV writes are precious (1k/day). Heartbeats/saves don't use KV, good.
- DO costs are separate from D1.

**What Kitty Factory needs:**
- No multiplayer required (tycoon is solo). Rooms optional.
- Needs frequent autosave (every 15-30s typical for idle), offline progress calculation, large state (factory layout, machines, pollution, currencies)
- Needs leaderboard (money/s, kitties/s, best kitty value) → requires verifier
- Needs tracking already provided
- Bundle size: idle tycoon UI heavy, but not WebGL heavy in 2D

Conclusion: infra covers 90% of needs out of box.

---

## 3. Game Design Breakdown — Systems & Scaling

**Core loop:**
```
Money -> buy machine -> machine produces kitties (staged) -> sell -> more Money
Pollution: Efficiency = 100% * e^(-k * pollution^2)
Conveyors: manual drag OR buy belt (QoL upgrade)
Expand: buy parcels, parcel upgrade reduces pollution modifier
Rebirth: treats = f(total kitties produced)
Evolution: super treats + color rarity
Kitception: incredible treats + race
Factory reset: factory credits + factory type
Move out: location multiplier
Synergies: Mom->Hatchery +10%, Artist->Printer auto-print, Chef->Bakery +25% value, Sculptor->3D Printer quality
```

**Sell Lemons parallel:**
- Lemon Stand's Click button with cooldown → kitty machine with production time
- Managers automate → conveyor belts / auto-drag
- Global upgrades → factory-wide upgrades (treats)
- Rebirth Investors logic (total including spent) → similar for treats to prevent hoarding exploit

**Pollution formula analysis:**
- `E = e^(-k * p^2)` is Gaussian decay. At k=0.0001, p=100 => E=36.7%, p=50 => 77.8%. Need to tune k per parcel. Suggest k = 0.00005-0.0002 baseline, parcel upgrade reduces k by 30-50% per level.
- Must show efficiency bar, not just number.

**Scaling formulas needed (proposed free formulas):**

Money cost scaling for machines:
```
cost_n = base * (1.15 ^ owned) * (1 + parcelPenalty)
```
Standard incremental (Adventure Capitalist uses 1.15). Keeps early cheap, late expensive.

Production value scaling for kitty rarity:
```
value = baseValue * (colorMult * traitMult * raceMult * accessoryMult) * (1 + synergyBonus) * efficiency
color: 0=black 1x, 1=brown 1.5x, 5=white 8x, 10=orange 30x → formula: colorMult = 1 + (level^1.8 * 0.5)
trait: tiny 1x → godlike huge → traitMult = 1.6^traitLevel
race: common 1x → alien anthropomorphic 50x → raceMult = 1.8^raceTier
```

Rebirth currency:
```
treats = floor( sqrt(totalKittiesProduced / 1e6) )   // or log10 based
SuperTreats = floor( log10(totalKitties/1e9 +1) * traitLevel )
Incredible = floor( totalKitties^(0.3) / 100 )
```
Must stay engaging: use sqrt/log to prevent explosion, but add multiplier per prestige layer.

Evolution/Prestige requirement (like Sell Lemons 501.2 Quadrillion Investors):
```
nextCost = base * (3.5 ^ evolutionLevel)   // x42 speed in Sell Lemons → Kitty could be x2.5 value per evolution
speedMult = 1.8 ^ evolutionLevel  // or 42 in Sell Lemons is huge, but okay for second reset
```

**Tracking metrics requested:**
- Money/s, Kitties/s, Value/kitty, Factory efficiency, Pollution, Production time, Best kitty value, Game time, Idle time, active time → all doable client-side, plus server tracking already logs active_ms.

**Save size concern:**
- Factory layout: parcels (maybe 10x10 grid) × machine type + level + pollution + conveyor direction. JSON ~2-5KB if optimized. With all prestige currencies + achievements + accessory gacha + stats history → could exceed 16 KiB limit per slot. Solutions: compress (store grid as string), split into multiple slots (game_saves supports 25 slots per game, you could use `factory-main` + `factory-stats`), or bump limit via migration (but free D1 row 2MB max, so 16KiB is app-level not DB limit). Easiest: use 1 slot with compact encoding, stays <16KiB.

---

## 4. Hosting Option A: Integrated `/games/kitty-factory/`

**How:** Add `bnji.kitty-factory` to `src/data/games.ts`, create `src/pages/games/kitty-factory.astro` using `GameShell`, client `src/scripts/games/kitty-factory.ts`, rules `src/game/kitty-rules.ts`, adapter `src/server/game-adapters/kitty-factory.ts` for leaderboard verifier.

**Pros:**
- Zero infra change. Reuses `BOARD_DB`, `BOARD_KV`, `GAME_ROOMS` (if you ever add co-op), player identity, saves, tracking, admin panel, leaderboard pattern, `GameShell` fullscreen, glass UI tokens.
- Auth: cookies work same-origin, no CORS, guest + account + handle labels automatically on leaderboard.
- Save system: 25 slots ×16KiB already built, IndexedDB offline queue, conflict resolution UI already exists on `/games/` page.
- Tracking: active/idle/game time automatically measured by `mountGameSession`.
- Deployment: single `wrangler deploy`, single build, sitemap includes game, no DNS.
- Free tier: stays within 100k Worker req/day, D1 writes are main constraint but idle games can throttle saves to 1/min (like heartbeat) → 100 DAU × 1440 min = 144k writes if every minute → too high. Must throttle to 1 save per 2-5 min or on important events only. Existing Stack/Chess do not autosave constantly; idle will need smarter throttling.
- SEO & discovery: appears in `/games/` catalog, linked from `GameCard`, existing nav.

**Cons:**
- Bundle size: idle tycoon with many sprites/UI could bloat main Astro build (currently 18 static pages). But Astro code-splits per page, client JS for kitty only loaded on its route (dynamic import via GameShell), so impact minimal.
- D1 write budget shared with board/paint/security. Heavy autosave could starve other features. Mitigation: local-first save (IndexedDB) + cloud sync debounced 2-5 min + only on prestige/major purchase, not every tick. Offline progress calc doesn't need server.
- 16 KiB save limit may need compact encoding.
- No isolation: bug in kitty game could affect main site build (but scoped).

**Implementation effort (2D):** Medium. Reuse existing patterns.

**Cost:** $0. No new bindings, no new DB.

---

## 5. Hosting Option B: Subdomain `kitty.bnji.net`

**Two sub-variants free:**

**B1: Same Worker, route-based subdomain handling**
- Cloudflare Workers can respond to multiple hostnames via Routes. Add `kitty.bnji.net/*` route to same Worker in Cloudflare dashboard. In `src/middleware.ts` or Astro, detect `host` and render different page. Still single Worker, single D1.
- Pros: single deploy, shared auth if cookie domain `.bnji.net`, shared D1, free.
- Cons: need to configure Cloudflare DNS (CNAME or proxied), custom routing logic, Astro `site` is `https://bnji.net` so canonical/OG would need override, sitemap filter would need to exclude/include. Slight complexity.

**B2: Separate Worker / Pages project `kitty`**
- Create new Cloudflare Worker or Pages project `kitty-bnji-net`, with its own `wrangler.json` or Pages config, own D1 `bnji-kitty` (free, within 10 DB limit), own KV if needed. Domain `kitty.bnji.net` via Cloudflare DNS.
- Pros: complete isolation, can use different framework (e.g., Vite + Phaser standalone, not Astro), heavier assets allowed (R2 free tier 10GB if needed for sprites, but spec says free only, R2 free still okay but adds binding), independent deploy pipeline, can experiment without risking main site, can have own leaderboard, can scale independently.
- Cons: 
  - Auth: need to share `BOARD_DB` or replicate identity. If separate D1, players need new account. To share, you'd need to bind same D1 ID in both Workers (possible, same database_id in wrangler.json, but then both Workers share write budget anyway). Cookie domain must be `.bnji.net` to share `bnji_ps` and player session cookies, requires `Domain=.bnji.net; SameSite=Lax` (currently cookies set without explicit domain? Check `player-context.ts` - need to verify). Cross-origin API calls from `kitty.bnji.net` to `bnji.net/api` need CORS + credentials.
  - Double operational overhead: two repos or monorepo with two wrangler configs, two deploy checks, two retention sweeps (if you duplicate worker.ts).
  - Free tier still shared account-wide: Worker requests, D1 reads/writes, KV, DO all count per account, not per Worker. So isolation doesn't give more quota, just logical separation.
  - SEO split: kitty content not in main sitemap unless you link.
  - Admin: need to duplicate or share admin panel.

**Cost:** Still $0 if using Free tier, but more config. No paid needed.

**When subdomain makes sense:**
- You want kitty to be its own brand/game, not just a mini-game.
- You expect heavy traffic that could saturate main site's 100k req/day and want separate analytics.
- You want to use a framework incompatible with Astro (e.g., pure Phaser + Vite, or SvelteKit, or even a WASM engine).
- You want to open-source kitty separately.

**When integrated makes sense (recommended):**
- You want fastest ship, reuse auth/saves/leaderboard/admin.
- You want to keep everything under bnji.net brand.
- You want to stay within single codebase and single deploy.
- Free tier headroom is sufficient with throttled saves.

**Hybrid recommendation:** Start integrated as `bnji.kitty-factory` (`/games/kitty-factory/`). If it grows beyond free budget or needs its own identity, you can later add a Cloudflare Route `kitty.bnji.net/*` → same Worker and make `https://kitty.bnji.net` 301 or serve same content with canonical override. That way you get both: integrated code, but vanity subdomain. Zero extra Worker.

---

## 6. Comparison Matrix

| Criteria | Integrated `/games/kitty-factory/` | Subdomain `kitty.bnji.net` same Worker | Subdomain separate Worker |
|---|---|---|---|
| Free cost | $0 | $0 + DNS config | $0 + DNS + extra project |
| Auth reuse | Native, same cookie | Possible with `.bnji.net` domain | Needs cross-domain or shared D1 |
| Save reuse | Native 25×16KiB | Native if same D1 | Needs new table or shared D1 |
| Leaderboard | Native verifier pattern | Native | Duplicate logic |
| Tracking | Native heartbeat | Native | Duplicate |
| Deploy complexity | Low (one wrangler) | Medium (routes + host logic) | High (two projects) |
| Bundle isolation | Astro code-split, okay | Same | Full isolation |
| D1 write budget | Shared, must throttle saves | Shared | Shared account-wide anyway |
| SEO | In main catalog | Split, needs extra sitemap | Split |
| Brand | Part of bnji.net games hub | Vanity URL possible | Strong separate brand |
| Maintenance | Low | Medium | High |
| Risk to main site | Low (scoped) | Low | None (isolated) |
| Future move | Easy to add vanity subdomain later | - | Hard to merge back |

---

## 7. 2D Indie vs 3D Roblox-Style — Difficulty with AI (Free Only)

### 7.1 2D Indie Style (Recommended)

**Visual target:** Top-down or isometric factory like Factorio-lite, Stardew Valley, or Sell Lemons 2D tycoon UI. Machines as cute sprites, kitties as icons, conveyors as animated tiles, parcels as grid.

**Free stack options:**
- **Pure Canvas 2D + Astro** (like existing Stack game): zero dependency, works with `GameShell`, smallest bundle, easiest for AI to generate. Use `src/game/kitty-rules.ts` for pure logic, `src/scripts/games/kitty-factory.ts` for renderer. Sprites via Kenney.nl (CC0), OpenGameArt, or AI-generated PNGs (Stable Diffusion free local or HuggingFace).
- **Phaser 3** (MIT): Industry standard 2D engine, built-in drag, tilemaps, particle, sound. Works as Astro island or standalone. Slightly larger bundle (~200KB gz). Free.
- **PixiJS 7** (MIT): Fast 2D WebGL renderer, good for many sprites, but need own game loop.
- **LittleJS** (MIT, 6KB): Minimal engine for jam games.
- **Kontra.js**: Lightweight.

**AI difficulty:**
- **Code generation:** Easy-Medium. AI can scaffold incremental loop, production chain, prestige formulas, drag-and-drop, grid placement, save/load. Many examples online.
- **Art:** Easy. Prompt "cute chibi kitty factory machine, isometric, pastel, transparent background" → generate 16-32px sprites, upscale. Free tools: Stable Diffusion (local), Craiyon, Pica, or Kenney assets avoid generation.
- **UI:** Easy. Reuse glass tokens from `src/styles/tokens.css`, `games.css`. AI can generate React-like UI or vanilla.
- **Performance:** Easy. 2D canvas handles 100s of sprites at 60fps mobile.
- **Mobile:** Easy. Touch drag, pointer events already in `GameCapability` (`touch`, `pointer`).
- **Time estimate with AI:** 2-4 weeks for MVP (factory, 5 machines, pollution, conveyor, save, one prestige), 6-8 weeks for full feature set (all machines, synergies, 4 prestige layers, accessories gacha, achievements, leaderboard).

**Pros:**
- Fits existing infra perfectly (canvas-2d capability)
- Small bundle, fast load, works offline
- Easy to balance formulas, easy to debug
- Free assets abundant
- Mobile-friendly

**Cons:**
- Less flashy than 3D Roblox

### 7.2 3D Roblox-Style

**Visual target:** 3D tycoon like Roblox Sell Lemons: third-person or isometric 3D, blocks, machines as 3D models, kitties as 3D chibi, conveyor as moving mesh.

**Free stack options:**
- **Three.js** (MIT): Most popular, huge examples, works with Astro via dynamic import. Need to handle camera, lights, shadows, GLTF models.
- **Babylon.js** (Apache 2.0): More batteries-included, but larger.
- **PlayCanvas** (MIT engine, free hosting tier): Editor free, but export needs work.
- **Model generation free:** TripoSR (open source image-to-3D), Meshy free tier (limited), Kenney 3D assets (CC0), Quaternius free models, or AI via Stable Diffusion + TripoSR local pipeline.

**AI difficulty:**
- **Code generation:** Hard. AI struggles with Three.js scene graph, camera controls, raycasting for drag-and-drop in 3D, conveyor belt animation via shader or mesh offset, performance optimization (instancing), lighting. Lots of boilerplate, many subtle bugs (z-fighting, shadow acne, pointer events in 3D).
- **Art:** Hard. Need 3D models for ~12 machines + kitty variants (color, trait, race, accessories) → combinatorial explosion. Even with AI image-to-3D, need rigging, texturing, optimization. Free models rarely match kitty theme.
- **Performance:** Hard. WebGL context probe already in `game-runtime.ts` but many mobiles have weak GPU. Need LOD, instancing, texture atlas. Bundle size 500KB-1MB+ for Three.js + models.
- **UI:** Medium-Hard. 3D + 2D UI overlay (glass panels) need to coexist, pointer events must not conflict.
- **Physics:** If you want kitties sliding on conveyors, need physics (cannon-es, ammo.js) → extra complexity.
- **Mobile:** Hard. Touch controls for 3D camera + drag is awkward, needs custom solution.
- **Time estimate with AI:** 6-10 weeks MVP (basic 3D factory, few machines, no accessories), 3-6 months full feature set. AI will need many iterations.

**Pros:**
- More immersive, closer to Roblox fantasy
- Wow factor

**Cons:**
- 3-4x dev time, higher bug surface
- Heavy bundle, slower load, worse mobile
- Free 3D assets limited for kitty theme
- Harder to make accessible (needs semantic controls fallback per GAMES-OPERATIONS.md)
- Existing `GameShell` expects 2D, would need custom shell

**Roblox itself as host?**
- If you meant actually hosting on Roblox platform (not web 3D style), that's free to create, but requires Lua, Roblox Studio, and you lose bnji.net integration entirely. Also Roblox takes 30% of revenue if you monetize, and you cannot reuse bnji.net auth/saves. Not recommended if you want web game.

### 7.3 Difficulty Comparison Table (Free, AI-assisted)

| Aspect | 2D Indie | 3D Roblox-style Web |
|---|---|---|
| Engine | Canvas/Phaser (0 deps or 1) | Three.js/Babylon (1 + loaders) |
| AI code gen success | 80-90% correct first try | 40-60%, many manual fixes |
| Art pipeline | 2D sprites, easy AI | 3D models, hard AI, need retopo |
| Bundle | 50-200KB | 500KB-2MB + models |
| Performance mobile | 60fps easy | 30fps struggle |
| Save size | Small (grid as string) | Larger (transforms) |
| Accessibility | Easy (DOM + canvas fallback) | Hard (need 2D fallback) |
| Build time | Fast | Slow |
| Learning curve | Low | High |
| Free assets | Abundant (Kenney, OGA) | Scarce for kitties |
| Time to MVP | 2-4 weeks | 6-10 weeks |
| Time to full | 6-8 weeks | 3-6 months |
| Fits existing infra | Perfect (`canvas-2d`) | Needs `webgl` capability, still fits but heavier |

**Recommendation:** Ship 2D indie first. Validate loop, prestige, pollution, synergies. If traction, add optional 3D view as stretch (e.g., isometric 2.5D using Stack game's iso projection already exists in repo!).

---

## 8. Proposed Scaling Formulas (Free, Engaging)

**Pollution:**
```
k_base = 0.00008
parcelLevel reduces k: k_eff = k_base * (0.7 ^ parcelLevel)
efficiency = exp(-k_eff * pollution^2)   // 0..1
Display as 100% * efficiency
```

**Machine cost:**
```
cost = base * 1.15^owned * (1 + totalMachines*0.01) // slight global inflation
```

**Production time:**
```
time = baseTime / (1 + speedUpgrade*0.2) / (globalSpeedMult)
```

**Kitty value:**
```
base = 10
colorMult = 1 + level^1.85 * 0.45  // 0=1x, 1=1.45x, 5=~12x, 10=~45x
traitMult = 1.65^traitTier
raceMult = 1.75^raceTier
accessoryMult = 1 + sum(accessoryBonus)/100
synergyMult = 1 + 0.1 per active synergy
value = base * colorMult * traitMult * raceMult * accessoryMult * synergyMult * efficiency
```

**Prestige currencies (like Sell Lemons Investors):**
```
// Rebirth treats: sqrt, like Adventure Capitalist angels
treats = floor( (totalKitties / 1e6) ^0.5 )

// Super treats: log10, requires evolution level
superTreats = floor( log10(totalKitties/1e9 +1) * (evolutionLevel+1) * 0.5 )

// Incredible treats: power 0.3, rarer
incredible = floor( (totalKitties ^0.28) / 150 )

// Factory credits: based on best kitty value
credits = floor( log10(bestValue/1000 +1) * factoryTier )
```

**Evolution requirement (Sell Lemons 501.2Q Investors style):**
```
requiredTotalKitties = 1e6 * (4.2 ^ evolutionLevel)   // exponential
requiredBestValue = 100 * (3.8 ^ evolutionLevel)
speedMult = 1.9 ^ evolutionLevel   // vs Sell Lemons x42 per evo, tune down
```

**Accessory gacha:** late game, special currency (e.g., yarn balls). Use weighted random, pity timer. Stats bonus only after certain factory level to avoid early pay-to-win feel (but free only).

---

## 9. Free-Only Tech Recommendations

**If integrated:**
- Engine: Vanilla Canvas 2D + existing `GameShell` + `mountGameLifecycle` (zero deps, matches Stack)
- Or Phaser 3 via `npm install phaser` (MIT, allowed per DEPENDENCY-POLICY.md Tier 2? Check — runtime dependency needs justification, but Phaser is justified for 2D game, document in GAMES-DECISIONS.md)
- State: `src/game/kitty-rules.ts` pure functions, no side effects, testable
- Save: compact JSON, LZ-string optional (but adds dep, better manual compact)
- Art: Kenney.nl + custom AI sprites via local Stable Diffusion (free) or free itch.io
- Sound: optional, Web Audio, free sfx via freesound.org, Kenney audio
- Leaderboard verifier: server replays production calculation from save snapshot? Or simpler: trust client for idle? Better: verifier checks that claimed money/s is plausible given save proof (like Stack does with drops). For idle, verifier could check `totalKitties` proof via hash of save.

**If subdomain separate Worker:**
- Vite + Phaser 3 or Vite + PixiJS, deploy via `wrangler deploy` or Cloudflare Pages (free)
- D1 binding to same `bnji-board` or new `bnji-kitty` DB
- Still free

**Avoid:**
- Paid: PlayFab, Firebase paid tier, R2 paid egress (R2 free tier is okay but not needed)
- Three.js for MVP unless you accept hard mode
- Any npm dep that requires Node polyfill in Worker (keep client-only)

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation (free) |
|---|---|---|
| D1 100k writes/day saturation | Saves fail, scores fail | Throttle cloud saves to 1 per 2-5 min, local-first IndexedDB, only cloud on prestige/important, batch writes |
| Save >16KiB | Rejected | Compact grid encoding: e.g., `parcel: "M2L1|..."`, store only deltas, use 2 slots if needed |
| Cheating leaderboard | Fake money/s | Verifier: server checks proof, or only allow best kitty value (harder to fake), or use increment pattern like PvP Minesweeper (attested via game logic) |
| Bundle bloat main site | Slow build | Code-split, dynamic import, keep kitty assets in `/public/games/kitty/` |
| Mobile performance | Lag | 2D canvas, limit particles, respect `prefers-reduced-motion` (already in game-runtime) |
| Cookie domain for subdomain | Auth breaks | Set cookie Domain=.bnji.net if subdomain, test same-site |
| AI art inconsistency | Ugly kitties | Use single style prompt + Kenney base, generate once, not runtime |

---

## 11. Final Recommendation

**Short answer:** Build as integrated 2D indie game first, under existing infra, with option to add vanity subdomain later.

**Path:**
1. Add `bnji.kitty-factory` to catalog, status `in-development`
2. Create `src/game/kitty-rules.ts` with formulas above (pure, testable)
3. Create `src/pages/games/kitty-factory.astro` + `src/scripts/games/kitty-factory.ts` using Canvas 2D, GameShell, glass UI
4. Implement save in one slot, compact, with IndexedDB queue (reuse `game-saves.ts`)
5. Implement leaderboard verifier in `src/server/game-adapters/kitty-factory.ts` (check plausible money/s or best value)
6. Throttle saves: local every 10s, cloud every 3 min or on prestige
7. Use free assets: Kenney, OGA, local SD for kitties
8. After MVP stable, add Route `kitty.bnji.net/*` → same Worker if you want vanity URL, keep single codebase

**Why not subdomain now:** Extra complexity for no extra quota (Free limits account-wide). Integrated gives you auth, saves, tracking, admin, leaderboard for free. Subdomain only adds value after product-market fit.

**Why not 3D now:** 3-4x harder with AI, worse mobile, larger bundle, scarce free kitty 3D assets. Start 2D, optionally add isometric 2.5D using existing Stack iso renderer as middle ground (free, already in repo, proven).

**Free options summary:**
- 2D engine: Canvas (0 cost) or Phaser 3 (MIT)
- Art: Kenney CC0 + local Stable Diffusion
- Sound: Kenney + freesound
- Hosting: Cloudflare Workers Free (existing)
- DB: D1 Free (existing)
- No paid APIs, no R2 needed, no external service

---

## 12. Open Questions for Owner

- Do you want offline progress (e.g., factory runs while away)? Yes → need lastSeen calc, easy.
- How aggressive should pollution be? Formula above tunable via admin config? Could add `src/config/kitty.config.ts` like other configs.
- Accessory gacha: gambling for stats bonus — free only, but need to decide if random is okay for leaderboard fairness (maybe cosmetics only, stats from achievements).
- Leaderboard metric: money/sec vs best kitty value vs total kitties? Best value is hardest to cheat, money/sec easy to inflate.
- Do you want to reuse `Presence` DO for live factory presence? Probably not needed for solo tycoon.

---

**References checked:**
- Sell Lemons Wiki: Rebirth (lose cash/sources, keep fruits/buttons/robux, gain Investors), Evolution (10 fruits loop +1, x42 speed, requires total Investors including spent), Income Sources (cooldown, managers automate, speed upgrades)
- Existing infra: `GAMES-DECISIONS.md`, `GAMES-OPERATIONS.md`, `games.ts`, `game-adapters.ts`, `worker.ts`, `game-store.ts`, `score-verifiers.ts`
- Cloudflare Free quotas verified via docs links in GAMES-OPERATIONS.md (100k Worker req/day, 100k D1 writes/day, 1k KV writes/day)

No code implemented, research only as requested.
