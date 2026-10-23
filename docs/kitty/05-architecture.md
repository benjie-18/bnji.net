# Kitty Factory — Architecture

## 5.1 Existing Infra (Verified)

- Astro 7 + @astrojs/cloudflare 14.3.1 → Worker Free 100k req/day, 10ms CPU
- D1 `bnji-board` (BOARD_DB) 5M reads/day, 100k writes/day, 500MB/DB
- KV `BOARD_KV` 100k reads/day, 1k writes/day — must NOT use for saves/heartbeats
- DOs: GAME_ROOMS, DM_CONVERSATIONS, PRESENCE — SQLite, 100k req/day, hibernation free
- Cron `0 * * * *` hourly retention, 60 rows/table/hour max ~33k writes/day
- Catalog `defineGameCatalog` validates IDs, description ≤12 words, one destination for available
- GameShell: instructions, pause/resume, fullscreen, boardHref, lifecycle events
- mountGameLifecycle(root, module) + mountGameSession(root, gameId): visibility pause, heartbeat 1/min, 45s min interval server, 65s clamp, 2min idle stop
- Saves: game_saves table, 25 slots×16KiB, revision CAS, IndexedDB queue 3 retries, conflict UI
- Scores: game_scores, one best per session/game/mode, top 500/mode, verifier required, fail-closed 503 verifier_unavailable
- Leaderboards: /projects/games/<slug>/leaderboard/ prerendered, 25 rows/page, label composed at read time handle·DisplayName
- Player identity: recovery code 160-bit shown once SHA256 stored, session token 256-bit HttpOnly cookie, guest bnji_ps cookie, handle [a-z0-9_]{3,20}

## 5.2 New File Structure

```
src/data/kitty-content.ts          // content tables
src/game/kitty-rules.ts            // pure logic tick, production chain
src/game/kitty-formulas.ts         // formulas
src/game/kitty-save.ts             // save schema, migrate, compact, offline
src/pages/projects/games/kitty-factory.astro // GameShell page
src/scripts/games/kitty-factory.ts // Three.js client
src/server/game-adapters/kitty-factory.ts // verifier
public/games/kitty/
  mom.glb, hatchery.glb, ... (12)
  icons/mom.png ...
  acc/hat.glb ...
src/styles/kitty.css (or extend games.css)
```

Modified:
- src/data/games.ts add bnji.kitty-factory entry
- src/data/game-adapters.ts add to SCORE_VERIFIER_GAMES
- src/server/game-adapters/register-all.ts import './kitty-factory'
- package.json add three@^0.160.0 (MIT) + justification in GAMES-DECISIONS.md
- docs/GAMES-DECISIONS.md document Three.js

## 5.3 Client Architecture

**Three.js setup:**
- Dynamic import `three` + `OrbitControls` + `GLTFLoader` + optional DRACOLoader
- Renderer: antialias, shadowMap PCFSoft, size = CSS box * DPR (max 2), like Stack fitCanvas()
- Scene: Ambient 0.6, Directional 0.8 shadows 1024, Hemisphere
- Ground: Plane + GridHelper, parcels as Boxes
- Machines: InstancedMesh per type, count 100, instanceMatrix update per machine x,y,rot, color tint via InstancedBufferAttribute
- Kitties: InstancedMesh single geometry, count 200, progress 0..1 along belt segments lerp, no physics
- Belts: Box + shader time uniform UV scroll
- Pollution: Fog color lerp green→brown based on efficiency, or per-parcel overlay plane opacity
- Controls: Orbit default (damping, minDistance 2, maxDistance 50, maxPolarAngle PI/2.1), build mode top-down ortho (0,50,0), inspect FP via PointerLock on double-click
- Input: raycaster for machine pick, pointerdown for place/drag, WASD for FP, Esc exit PointerLock
- UI DOM: glass panels, HUD top money/treats/efficiency/money/s/kitties/s/best, build toolbar left, parcel panel, prestige panel with confirmation modal, minimap bottom-right 2D canvas, manual save button + status data-player-live
- Lifecycle: init creates scene, pause stops RAF+controls, resume restarts, destroy disposes renderer/controls/listeners/audio
- Tracking: mountGameSession auto heartbeats
- Save: local IndexedDB every 10s via saveLocalProgress, cloud every 2min throttled + manual + prestige, offline calc via lastSeenAt

**Astro page:**
- GameShell gameId bnji.kitty-factory, title Kitty Factory, instructions, boardHref leaderboardHref(getGame('bnji.kitty-factory')!)
- Slot: canvas data-kitty-canvas + div data-kitty-ui + minimap + toolbar
- Results slot: claim form like Stack
- Script: initGameShells(), mountGameLifecycle, mountGameSession, createKittyFactoryGame()

## 5.4 Server Architecture

- Verifier: registerScoreVerifier('bnji.kitty-factory', async (claim) => { if mode != default return null; proof = {totalKitties, bestValue, machineCounts}; max = maxPlausibleValue(counts); if bestValue > max*1.1 return null; return {score:bestValue, tieBreak:totalKitties} })
- Mode default = best kitty value (hardest to cheat)
- Idempotency key kitty-${runToken}
- Auto-submit only when beatsBest (reuse game-scores.ts logic)
- No room authority (solo)

## 5.5 Save Handling

- Local: saveLocalProgress('bnji.kitty-factory','main', SAVE_VERSION, compactEncode(save)) every 10s
- Cloud: put via game-saves.ts with expectedRevision, throttled 2min, manual, prestige
- Load: read local, then cloud, compare updatedAt, conflict UI existing
- Manual button data-kitty-save debounced 5s
- Offline: lastSeenAt, offlineProgress() capped 2h

## 5.6 Leaderboard

- /projects/games/kitty-factory/leaderboard/ prerendered from hasLeaderboard (needs verifier)
- 25 rows/page, label handle·DisplayName composed at read time
- Score = bestValue, tieBreak = totalKitties

## 5.7 Asset Pipeline

- Public folder static, not counted against Worker requests
- GLB Draco compressed via gltf-transform
- Size budget <500KB total

## 5.8 Performance

- InstancedMesh, frustum culling, LOD, shadows toggle, belt shader time uniform, RAF only when visible, DPR max 2, potato mode toggle
- Mobile: touch orbit one finger rotate, two finger zoom/pan, long press place, reduce instances to 50

## 5.9 Accessibility

- Top-down build mode with buttons, keyboard controls, prefers-reduced-motion respect, semantic DOM UI, WebGL context lost fallback to 2D build mode

