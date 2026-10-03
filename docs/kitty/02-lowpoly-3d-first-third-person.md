# Kitty Factory — Low-Poly 3D First/Third Person Addendum

**Question:** Can it run as low-poly 3D first/third person integrated in existing `/games/` infra? Playable at target scale? Saves often (manual + every couple minutes) with low player count.

**Short answer: Yes, fully feasible integrated. Low player count makes frequent saves viable. Recommend third-person orbit + optional first-person inspection, not pure FPS.**

---

## 1. Does existing infra support WebGL 3D?

Yes.

- `GameCapability` already includes `'webgl'` (`src/data/games.ts`). Catalog validates it.
- `game-runtime.ts` probes WebGL2: `document.createElement('canvas').getContext('webgl2')` → `webgl2: boolean` fact passed to game module. It also handles `webglcontextlost/restored` (FluidSandbox does).
- Precedent: `FluidSandbox` is WebGL2 metaballs with Canvas2D fallback, `VoxelMap` is 3D isometric with raycasting, orbit, depth sorting, brush. So 3D in Lab already ships.
- `GameShell.astro` supports fullscreen toggle (button hidden until Fullscreen API exists). Works for Three.js canvas. `data-game-field` token in `tokens.css` gives you `--game-field` background.
- Capabilities you need: `['keyboard','pointer','touch','webgl','audio']` — all already defined.
- Bundle: Astro code-splits per page, Three.js only loaded on `/games/kitty-factory/` route via dynamic import, does not bloat main site.

So integration is: `bnji.kitty-factory` with `href: '/games/kitty-factory/'`, `capabilities: ['keyboard','pointer','webgl']`, `GameShell` + `mountGameLifecycle` + `mountGameSession` same as Stack/Chess.

## 2. Low-Poly 3D is the right 3D subset for this scale

**Why low-poly fits your game design:**

- Machines: 12 types × levels → instanced low-poly meshes (Kenney Factory Kit, Kenney City Kit) = ~200-800 tris each, one material per type. 100 machines = 100 draw calls if naive, 12 if instanced by type via `THREE.InstancedMesh`.
- Kitties: simple chibi capsule + ears + tail, color/trait/race as material tint + scale, not separate models. Accessories (hat, glasses) = tiny extra meshes parented.
- Conveyors: not physics, just UV scroll shader or moving boxes on spline. Cheap.
- Parcels: 10×10 grid = ground tiles, low-poly.
- Pollution: `Efficiency = e^(-k*p^2)` → visual as fog tint or emissive color, cheap.

**Free assets (no paid):**
- Kenney.nl: `factory-kit`, `city-kit-suburban`, `animal-kit` (CC0) — perfect low-poly machines
- Quaternius: Ultimate Low Poly packs (CC0)
- Kay Lousberg: KayKit
- Models: GLB ~5-30KB each, Draco compressed (Three.js DracoLoader free)

**Free engine:**
- **Three.js r160+** MIT: 145KB gz, huge examples, `OrbitControls`, `PointerLockControls`, `InstancedMesh`, `GLTFLoader`. Best docs for AI.
- Babylon.js 7 Apache2: bigger, more batteries, but heavier.
- No need for physics engine; use AABB grid for placement.

AI difficulty: Three.js low-poly is **medium-hard** (vs 2D easy). AI can scaffold scene, controls, instancing, but will struggle with pointer-lock + UI overlay + save encoding. Still doable with iteration.

## 3. First-Person vs Third-Person vs Hybrid

**Pure first-person (PointerLockControls, WASD + mouse look):**
- Pros: Immersive, you walk factory floor, inspect kitties up close. Fits "garage → industrial complex" fantasy.
- Cons: 
  - Tycoon optimization requires overview. In FP you can't see whole production line. You'd need to walk far as factory expands (parcels).
  - Motion sickness, accessibility issues (needs fallback per GAMES-OPERATIONS.md: "Future games must offer semantic controls").
  - Mobile: touch joystick + look is awkward, needs dual sticks.
  - Building: placing machines in FP is imprecise.

**Third-person orbit (like Roblox tycoon, Factorio 3D, Satisfactory):**
- Pros: Best compromise. Orbit camera around factory, zoom, pan. Can see entire line. Still 3D immersion. Works with mouse + touch.
- Cons: Need collision for camera (avoid clipping through machines).

**Recommended: Hybrid**
- Default: third-person orbit (OrbitControls with damping, min/max distance, polar angle clamp).
- Build mode: top-down orthographic (like VoxelMap) — camera lifts to 80° angle, grid snap, place machines, drag conveyors.
- Inspect mode: click kitty/machine → first-person inspection (PointerLock or close-up) optional, not required for economy.
- Add minimap + fast-travel to parcels to handle scale.

This keeps it playable at your target scale: early small factory feels cozy in FP, late industrial complex still manageable via orbit + minimap + parcel teleport.

## 4. Playability at your target scale

Your scale: 12 machine types, multiple levels, parcels expansion, pollution per parcel, synergies, 5 prestige layers (treats, super, incredible, credits, move-out planets), accessories gacha.

**In low-poly 3D:**

- **100 machines + 50 conveyors + 200 kitties on belts**: feasible at 60fps desktop, 30-45fps mobile if low-poly + instanced + no shadows or baked shadows. Use:
  - InstancedMesh per machine type
  - Kitty as instanced too (same geometry, different color/scale via InstancedBufferAttribute)
  - Conveyor kitties move via shader offset, not individual physics
  - Frustum culling + LOD: far parcels low detail
  - Shadows: off or single directional with low res (1024) for mobile toggle

- **Factory expansion**: parcels as chunks. Load/unload chunks outside camera frustum. Keep active production simulation decoupled from rendering (simulation runs in `kitty-rules.ts` tick, rendering just visualizes).

- **Pollution**: `k_eff = k_base * 0.7^parcelLevel`, efficiency affects production speed. Visual: per-parcel fog color lerp green→brown, or machine emissive dimming. Cheap.

- **Synergies** (Mom→Hatchery +10%): check proximity in grid, not 3D distance, to keep logic simple.

So yes, playable. Roblox tycoons handle similar scale in 3D with low-poly and they have worse engine constraints than Three.js.

## 5. Saves: frequent manual + every couple minutes, low player count

**Current save system:**
- `game_saves` table: `player_id, game_id, slot_id, schema_version, revision, data_json (≤16384 bytes), updated_at`, PK `(player_id, game_id, slot_id)`, max 25 slots/player.
- API `POST /api/games/saves` uses CAS revision, returns 409 with current data on conflict. Browser has IndexedDB pending queue, 3 retries, offline support, conflict prompt UI on `/games/` page.
- D1 Free: 100k rows written/day shared account-wide. KV not used for saves.

**Math for your case (low player count):**

Assume 2h session per DAU, save every 2 min auto + 10 manual:

- Auto: 60 saves / session
- Manual: 10 saves / session
- Total: 70 writes / DAU / day for saves
- Heartbeats: `mountGameSession` sends 1/min while visible → 120 writes / DAU / day
- Retention sweep: fixed ~33k writes/day (from GAMES-OPERATIONS.md: 60 rows/table/hour max)
- Board, paint, security, etc.: ~few k

Examples:
- 20 DAU: saves 1,400 + heartbeats 2,400 + sweep 33k = ~36,800 writes/day → **63% headroom**
- 50 DAU: saves 3,500 + heartbeats 6,000 + sweep 33k = 42,500 → **57% headroom**
- 100 DAU saving every 1 min (120/session): saves 12k + heartbeats 12k + sweep 33k = 57k → still okay
- 100 DAU saving every 30s: saves 24k + 12k + 33k = 69k → okay but nearing limit

**Conclusion:** With <50 DAU, saving every 2 min + manual is safe. Even 100 DAU every 2 min is safe.

**Implementation to stay safe:**

- Local-first: write to IndexedDB every 10s (free, no D1 cost), cloud sync every 2 min debounced + on important events (prestige, parcel buy, manual button). Existing `game-saves.ts` already has pending queue.
- Use single slot `main` with revision increment. 16KiB limit: need compact encoding.
  - Grid: store as string `parcelId: x,y,type,level,rot` not full JSON objects. Example: `A1:0,0,MOM,3,0|0,1,HATCH,2,90` ~30 bytes/machine. 100 machines ~3KB.
  - Kitties in transit: don't save individual kitty positions, save queue counts per belt segment + RNG seed. Recalculate on load.
  - Currencies as numbers, not objects.
  - Should fit <8KB, leaving room for prestige, accessories, stats.
- Manual save button: debounce 5s, disable while pending, show `data-player-live` status.
- Offline progress: save `lastSeenAt = Date.now()` on each cloud save. On load, compute `offlineMs = now - lastSeenAt`, simulate production `offlineMs * efficiency * speedMult` capped at 2h (to prevent huge offline gains). No server needed.

**No extra D1 needed.** Existing table works.

## 6. Integration sketch (free, no new bindings)

```
src/data/games.ts: add bnji.kitty-factory, href /games/kitty-factory/, capabilities ['keyboard','pointer','touch','webgl','audio'], status 'in-development'
src/game/kitty-rules.ts: pure logic — machine definitions, cost scaling 1.15^owned, production, pollution E=e^(-k*p^2), synergies, prestige formulas, tick(dt)
src/pages/games/kitty-factory.astro: GameShell with instructions, boardHref from leaderboardHref(), <canvas data-kitty-canvas> + UI overlay (money, kitties/s, efficiency)
src/scripts/games/kitty-factory.ts: Three.js dynamic import, create scene, OrbitControls + PointerLockControls toggle, InstancedMesh for machines, instanced kitties, conveyor shader, mountGameLifecycle (pause/resume stops RAF), mountGameSession
src/server/game-adapters/kitty-factory.ts: registerScoreVerifier — verify best kitty value plausible from save proof (like Stack replays drops). Return {score, tieBreak}. Add to register-all.ts + SCORE_VERIFIER_GAMES.
src/styles/games.css: add .kitty-* tokens
public/games/kitty/: GLB low-poly assets (Kenney) ~200KB total
```

No new Worker, no new D1, no R2 needed (assets in /public served as static, not counted against Worker requests).

## 7. Risks & Mitigations for 3D integrated

- WebGL context lost on mobile: listen `webglcontextlost` → pause, show fallback message, offer 2D build mode. FluidSandbox already does this.
- Pointer lock requires user gesture: bind to click on canvas, not auto.
- Motion sickness: respect `prefers-reduced-motion`, provide option to disable bob, keep FOV 70°.
- Save size >16KiB: compact encoding, or use 2 slots (main + stats) — allowed, 25 slots.
- D1 write spam from manual saves: debounce manual button 5s, show cooldown.
- Performance mobile: toggle shadows, reduce instance count, offer "potato mode" (no kitty meshes, just icons).
- Accessibility: need semantic controls fallback per docs — provide top-down build mode with buttons, not only 3D drag.

## 8. Final Verdict

- **Can it run integrated?** Yes. Existing infra already supports WebGL, GameShell fullscreen, lifecycle pause, saves, leaderboards. No new bindings.
- **Playable at your scale?** Yes if low-poly + instanced + hybrid camera (orbit default, top-down build, optional FP inspect) + chunked parcels + minimap/teleport. Pure FP would be unplayable at industrial-complex scale; hybrid solves it.
- **Frequent saves?** Yes, with low player count (<50 DAU) saving every 2 min + manual is well within Free 100k writes/day (≈37k total). Use local-first IndexedDB every 10s, cloud every 2 min, compact encoding <16KiB, offline calc via lastSeenAt.
- **Recommendation:** Start with third-person orbit low-poly MVP (5 machines, 1 prestige, pollution, 1 parcel expansion), ship integrated as `/games/kitty-factory/`. Validate loop, then add more machines/prestige. Keep vanity `kitty.bnji.net` route as future option, not separate Worker.

If you want, I can draft the compact save schema and Three.js instancing setup next.
