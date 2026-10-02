# Kitty Factory — Optimized 4-5 Prompt Plan (Best Quality)

**Goal:** Full low-poly 3D hybrid game in 4-5 Claude Fable 5.1 prompts, best compatibility, aesthetic, performance, free-only.

**Philosophy:** Data-driven + procedural placeholders first (fast, no external assets) → Kenney GLB replacement → polish + shaders + verifier. Each prompt is verified before next.

---

## Prompt 1 — Scaffolding + Data Foundation (Best Compatibility)

**Why first:** Establishes catalog, save, content tables, Three.js base with compatibility handling. Everything else imports this.

**Prompt to Claude:**

```
You are building Kitty Factory for bnji.net per docs/kitty/00-overview.md, 03-implementation-plan.md, 04-data-schema.md.

Phase 0 — Scaffolding + Data Foundation, best compatibility:

1. Add dependency three@0.160.0 (MIT) to package.json, document justification in docs/GAMES-DECISIONS.md: "Low-poly 3D tycoon needs Three.js for InstancedMesh + OrbitControls + GLTFLoader, no vanilla alternative for low-poly factory at scale, free MIT, client-only, code-split per route"

2. Create src/data/kitty-content.ts per 04-data-schema.md — full tables: MACHINES 13 entries, KITTY_COLORS 11, TRAITS 15, RACES 22, FACTORY_TYPES 4, LOCATIONS 7, ACCESSORIES 5, PARCEL_COST, PRESTIGE, ACHIEVEMENTS 10. Use as const, no hardcoded IDs elsewhere.

3. Create src/game/kitty-formulas.ts per 04-data-schema.md — all formulas pure, no DOM.

4. Create src/game/kitty-save.ts per 04-data-schema.md — SAVE_VERSION=1, createNewSave(), migrate(), compactEncode/Decode (JSON.stringify for MVP, size check <16KiB for 100 machines), offlineProgress() capped 2h.

5. Create src/game/kitty-materials.ts — best aesthetic low-poly:
   - 3 materials max: matFactory (MeshStandardMaterial color #E8E8E8 roughness 0.8 metalness 0 flatShading true), matPastel (color #FFB5C2 roughness 0.9), matAccent (color #7DD3C0 roughness 0.7)
   - No textures, vertexColors false for MVP, flatShading true for low-poly faceted look
   - Export as const MATERIALS

6. Create src/pages/games/kitty-factory.astro per 05-architecture.md:
   - GameShell gameId bnji.kitty-factory title "Kitty Factory" description "Build kitties, optimize factory, prestige endlessly." (6 words OK ≤12)
   - capabilities handled via catalog, not here
   - Slot: <canvas data-kitty-canvas style="width:100%;aspect-ratio:16/9;display:block"> + <div data-kitty-ui> HUD placeholders + minimap <canvas data-kitty-minimap width=200 height=200> + build toolbar + manual save button data-kitty-save + status data-player-live
   - Results slot: claim form like stack.astro (displayName input, submit)
   - Styles: import kitty.css or inline, use tokens.css --game-field, --glass-*
   - Script: initGameShells(), mountGameLifecycle, mountGameSession, dynamic import('./kitty-factory')

7. Create src/scripts/games/kitty-factory.ts Phase 0 minimal:
   - Dynamic import three + OrbitControls from three/addons/controls/OrbitControls.js
   - fitCanvas() like stack.ts: CSS box * DPR max 2, aspect-ratio 16/9, handle ResizeObserver
   - Scene: THREE.Scene background #0A0A12, FogExp2 #0A0A12 density 0.02 for low-poly depth
   - Camera: Perspective 60°, FOV 70°, near 0.1 far 100, position (10,10,10) look at (0,0,0)
   - Renderer: WebGLRenderer canvas data-kitty-canvas antialias true alpha false, shadowMap enabled PCFSoft 1024, toneMapping NoToneMapping
   - Controls: OrbitControls damping true minDistance 2 maxDistance 50 maxPolarAngle PI/2.1
   - Lights: Ambient 0.7, Directional 0.8 castShadow 1024 at (10,20,10), Hemisphere 0.3
   - Ground: PlaneGeometry 50x50 MeshStandardMaterial #2A2A35, GridHelper 50 divisions 10
   - One procedural machine placeholder: BoxGeometry 1x1x1 with matFactory at (0,0,0) to verify pipeline
   - Lifecycle: export createKittyFactoryGame() returning {module:{init,pause,resume,destroy}} per game-runtime.ts pattern, pause stops RAF, resume restarts, destroy disposes renderer+controls+listeners
   - Save: import kitty-save.ts, local IndexedDB via game-saves.ts saveLocalProgress every 10s, cloud throttled 2min via maybeCloudSave(), manual button data-kitty-save debounced 5s, offline calc on load via offlineProgress()
   - WebGL context lost: canvas.addEventListener('webglcontextlost', e=>{e.preventDefault(); pause(); showFallback()}) + 'webglcontextrestored' resume
   - Reduced motion: respect matchMedia('(prefers-reduced-motion)'), disable damping if true
   - No belts/kitties yet, just ground + 1 box + orbit

8. Update src/data/games.ts add:
{
  id:'bnji.kitty-factory',
  title:'Kitty Factory',
  description:'Build kitties, optimize factory, prestige endlessly.',
  status:'in-development',
  href:'/games/kitty-factory/',
  capabilities:['keyboard','pointer','touch','webgl','audio'],
  modes:['default'],
}

9. Update src/data/game-adapters.ts add 'bnji.kitty-factory' to SCORE_VERIFIER_GAMES, add MODE_LABEL default:'Best Value'

10. Update src/server/game-adapters/register-all.ts add import './kitty-factory'

11. Create src/server/game-adapters/kitty-factory.ts skeleton:
registerScoreVerifier('bnji.kitty-factory', async (claim) => {
  if (claim.modeId !== 'default') return null;
  const proof = claim.proof as any;
  if (!proof || typeof proof.bestValue !== 'number') return null;
  return { score: proof.bestValue, tieBreak: proof.totalKitties ?? 0 };
});

12. Verify: npm run build passes, tsc --noEmit 0 errors, dist contains /games/kitty-factory/index.html, save size <16KiB test, canvas exists.

Do NOT implement full game, only scaffolding + data foundation. Stop after verification.
```

**Verification:** build OK, tsc 0, page loads with orbitable box, save local works, cloud throttled.

---

## Prompt 2 — MVP Core Loop + Procedural Low-Poly Assets (Best Aesthetic)

**Why second:** Core tycoon loop playable, procedural assets give low-poly aesthetic without external GLB, best quality for low-poly.

**Prompt:**

```
Continue Kitty Factory per docs/kitty/03-implementation-plan.md Phase 1, best low-poly aesthetic, basic shaders:

1. In src/data/kitty-content.ts ensure 5 MVP machines: mom, hatchery, artist, printer, adoption. Keep full 13 for later but MVP uses 5.

2. In src/game/kitty-rules.ts create pure logic (no Three.js):
   - FactoryState = { money, parcels, totalKitties, bestValue, gameTime, currencies, prestige, upgrades, stats }
   - tick(dt, state): for each machine in parcels, if enough time passed, produce kitty, add pollution, compute efficiency via kEff + pollutionEfficiency, compute value via kittyValue(), add money, update totalKitties, bestValue, stats moneyPerSec/kittiesPerSec via moving average
   - canAfford(), buyMachine(), buyParcel(), upgradeParcel(), placeMachine(x,y,rot), removeMachine(), addBelt(), synergy detection: for each parcel, check adjacent machines within 2 grid units, if MACHINES synergy match, apply bonus
   - No DOM, no THREE, fully testable

3. In src/scripts/games/kitty-factory.ts expand:
   - Procedural low-poly assets (best aesthetic, no external GLB):
     function createMachineMesh(id:string): THREE.Group {
       const g = new THREE.Group();
       // Use MATERIALS from kitty-materials.ts, flatShading true, low-poly primitives
       // mom: Box 1x1x1 + Sphere 0.5 ears (8 segments) + Cylinder tail
       // hatchery: Box 1.2x0.8x1.2 + half-sphere dome
       // artist: Table Box 1.5x0.2x1 + Box easel
       // printer: Box 1x1x1 + Box tray
       // adoption: Shop Box 2x1.5x1 + Box roof
       // All with flatShading, no textures, pastel colors via matPastel
       // Return Group
     }
     Keep <800 tris per machine, 6-12 faces per primitive.
   - InstancedMesh per machine type: create InstancedMesh with geometry from createMachineMesh(id) merged, count 100, instanceMatrix update per machine position (grid x,y -> world x,z), rotation y = rot * PI/2
   - Grid: 10x10 per parcel, world size 1 unit per cell, parcels offset by 12 units
   - Placement: raycaster from mouse to ground plane, snap to grid, preview ghost mesh with opacity 0.5 green if canAfford else red
   - Drag: pointerdown on kitty (instanced) → drag to next machine, or buy belt
   - Belts: BoxGeometry 1x0.1x0.5 with custom ShaderMaterial basic shader:
     uniform float time;
     varying vec2 vUv;
     void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
     fragment: uniform float time; varying vec2 vUv; void main() { float scroll = fract(vUv.x + time*0.5); float stripe = step(0.5, fract(scroll*4.0)); gl_FragColor = vec4(vec3(0.3+stripe*0.2),1.0); }
     time uniform updated each frame, gives moving stripes low-poly aesthetic, no texture needed
   - Kitties: InstancedMesh capsule (CapsuleGeometry 0.3 radius 0.5 height 4 segments) + 2 spheres ears, count 200, position along belt via progress lerp between belt segments, bob y = sin(time*5 + index)*0.05
   - Pollution visual: per-parcel FogExp2 density = 0.02 + pollution*0.0005, color lerp #0A0A12 -> #3A2A1A based on efficiency, plus ground emissive dimming via material.emissive lerp
   - HUD DOM: money, money/s, kitties/s, efficiency %, best value, treat counts, build toolbar with machine buttons (cost, canAfford disabled), parcel buy button, pollution bar per parcel
   - Offline progress: on load, compute offlineProgress() and add gains, show popup "Welcome back! Earned $X and Y kitties while away"
   - Save: keep Phase 0 throttling, plus save on buy/place/prestige

4. UI/UX: glass panels per tokens.css, build toolbar left, HUD top, minimap bottom-right 2D canvas top-down view of parcels (draw rects for machines, lines for belts, click to teleport camera)

5. Verify: place 20 machines, 10 belts, 50 kitties on belts, 60fps desktop, 30fps mobile, save <16KiB, offline works, build toolbar works, pollution reduces efficiency visibly.

Stop after MVP playable.
```

**Aesthetic best practices used:** flatShading true, 3 materials max, pastel palette, no textures, FogExp2 for depth, basic shader for belts (UV scroll), emissive dimming for pollution, instancing for performance.

---

## Prompt 3 — Full Content + Prestige + Synergies (Data-Driven)

**Why third:** Adds all content without changing core logic, easy updates.

**Prompt:**

```
Continue Kitty Factory Phase 2 per docs/kitty/04-data-schema.md and 07-update-guide.md:

1. Expand MACHINES from 5 MVP to full 13 (add chef, bakery, sculptor, vending, stickers, plushie, 3d-printer, robot-assembler) in kitty-content.ts — no logic change, just config.

2. Implement full prestige layers in kitty-rules.ts:
   - Rebirth: requireMoney 1e6, resets money/machines (keep parcels level?), gain treats = floor((totalKitties/1e6)^0.5), confirmation modal like Sell Lemons
   - Evolution: requireTreats 100 + totalKitties 1e9, resets rebirth, gain superTreats, unlock color levels and trait levels, speed mult 1.9^evolution
   - Kitception: requireSuperTreats 50, resets evolution, gain incredible, unlock races tier
   - Factory reset: requireIncredible 20, resets kitception, gain factoryCredits, unlock FACTORY_TYPES tier, reduces k
   - Move out: requireCredits 10, resets factory, gain locationPoints, unlock LOCATIONS mult
   - Each prestige has factory-wide upgrades in upgrades Record: production speed, pollution reduction, conveyor speed, value mult — bought with respective currency

3. Implement synergies: in tick(), for each parcel, for each machine, check MACHINES synergies, if other machine within 2 grid units, apply bonus to production time or value, show visual link line (LineBasicMaterial) + particle (small sphere) when synergy active

4. Implement parcel upgrades: buy parcel costs base*2.5^owned, upgrade costs base*2.2^level, reduces k via kReduction 0.7^level, visual via ground color lerp

5. Implement kitty value with full formulas: colorMult, traitMult, raceMult, accessoryMult, synergyMult, efficiency — bestValue tracking

6. Implement achievements per ACHIEVEMENTS table: check conditions each tick, unlock, reward yarn

7. Implement accessories gacha: yarn currency from achievements/bestValue, weighted random per ACCESSORIES weight, pity timer 20 rolls guaranteed rare, bonus to value, cosmetic small meshes parented to kitty (hat = cylinder on head)

8. UI: prestige panel with 5 buttons, requirements, confirmation modal, upgrades shop per prestige currency, achievements panel, accessories panel with gacha button

9. Save: bump SAVE_VERSION to 2 if needed, add migrate step for new currencies, ensure compactEncode still <16KiB for 100 machines (test)

10. Verify: prestige loop works, treats etc gained, upgrades persist after reset, synergies give bonus, parcel upgrade reduces pollution, achievements unlock, accessories gacha works, save migrates.

Stop after full content playable.
```

---

## Prompt 4 — Polish + Shaders + Leaderboard + Mobile (Best Quality)

**Why fourth:** Makes it shippable, best aesthetic with basic shaders, performance, leaderboard.

**Prompt:**

```
Continue Kitty Factory Phase 3 polish per docs/kitty/05-architecture.md and 06-asset-pipeline.md, best quality low-poly 3D:

1. Replace procedural placeholders with Kenney GLB (optional, keep procedural fallback):
   - Create public/games/kitty/ folder, add GLBs from Kenney factory-kit CC0 (or keep procedural if no GLB)
   - In kitty-factory.ts, try GLTFLoader load model, if fails fallback to procedural createMachineMesh()
   - Use DRACOLoader optional for compressed GLB

2. Basic shaders — best low-poly aesthetic, compatibility:
   - Keep MeshStandardMaterial with flatShading true, roughness 0.8 metalness 0 for all machines (3 materials max)
   - Belt shader: ShaderMaterial with time uniform UV scroll stripes (already from Prompt 2) — keep simple, no textures
   - Synergy shader: small emissive pulse — when synergy active, machine material emissive lerp #000000 -> #7DD3C0 sin(time*3)*0.2
   - Pollution shader: per-parcel ground ShaderMaterial with uniform pollution 0..1, fragment lerp color #2A2A35 -> #5A3A2A based on pollution, simple
   - No post-processing, no PBR heavy, no shadows ultra — keep compatibility

3. Performance optimizations:
   - InstancedMesh per type (already), FrustumCulling default, LOD: far parcels (>30 units) use BoxGeometry low-poly, near use detailed
   - Shadows: single DirectionalLight 1024 res, toggle off for potato mode (settings)
   - DPR max 2, already in fitCanvas()
   - RAF only when visible via mountGameLifecycle pause
   - Minimap 2D canvas top-down, not 3D

4. Mobile + Accessibility:
   - Touch: OrbitControls with one finger rotate, two finger zoom/pan, long press 500ms to place machine, double tap to inspect
   - Joystick optional for FP: if PointerLock not available, show on-screen joystick div
   - Reduced motion: respect matchMedia, disable damping, disable bob, disable emissive pulse
   - Keyboard: WASD for FP, Esc exit PointerLock, Tab focus build toolbar, semantic buttons
   - WebGL context lost: pause, show fallback message "WebGL lost, switching to top-down build mode" with Canvas2D fallback (grid + rects)

5. Leaderboard + Verifier:
   - Update src/server/game-adapters/kitty-factory.ts with maxPlausibleValue check per 04-data-schema.md
   - Proof includes totalKitties, bestValue, machineCounts, prestige levels, saveHash
   - Return score=bestValue, tieBreak=totalKitties
   - Client auto-submit only when beatsBest via game-scores.ts beatsBest logic, idempotency key kitty-${runToken}

6. UI polish:
   - Glass panels per tokens.css, HUD with money/s, kitties/s, efficiency bar, best value, treat counts
   - Build toolbar with cost, canAfford disabled, category tabs
   - Minimap clickable to teleport camera
   - Manual save button debounced 5s, status in data-player-live
   - Settings: sound toggle (Web Audio optional), potato mode (no shadows, reduced instances 50), reduced motion toggle
   - Prestige confirmation modals like Sell Lemons

7. Audio optional: Web Audio, play only after user gesture, free sfx Kenney

8. Verify per 08-checklist.md: build OK, tsc 0, save <16KiB, D1 write math, WebGL lost handled, mobile touch, leaderboard page prerenders, no example.com/localhost in dist, potato mode works, offline progress, synergy visual.

Stop after polish, ready for launch.
```

**Best methods used:** flatShading, 3 materials max, basic shaders (UV scroll, emissive pulse, pollution lerp), no textures, FogExp2, instancing, DPR max 2, Orbit + PointerLock hybrid, touch handling, reduced motion, context lost fallback.

---

## Prompt 5 — Testing + Launch + Update Guide (Final)

**Why fifth:** Ensures shippable, easy future updates.

**Prompt:**

```
Finalize Kitty Factory per docs/kitty/08-checklist.md:

1. Unit tests:
   - src/game/kitty-rules.test.ts: machine cost, pollution efficiency, kitty value, prestige formulas, synergy detection
   - src/game/kitty-save.test.ts: migrate v1->v2, compact size <16KiB, offlineProgress
   - src/server/game-adapters/kitty-factory.test.ts: verifier plausible and cheat rejection

2. E2E: add test for /games/kitty-factory/ loads, canvas exists, build button clickable, save button works, leaderboard link

3. Manual test checklist per 08-checklist.md

4. Update docs/GAMES-DECISIONS.md with Three.js justification, docs/GAMES-OPERATIONS.md with kitty write budget (20 DAU 37k/day)

5. Set status in src/data/games.ts to 'available' when ready

6. Create docs/kitty/12-best-practices.md summarizing compatibility, aesthetic, shaders

7. Verify: npm run build, tsc, test, test:do, test:e2e, grep dist for example.com/localhost

8. Deploy: git push, Cloudflare Workers Builds auto, verify /games/kitty-factory/ and /games/kitty-factory/leaderboard/ and /api/games/saves

9. Document update process per 07-update-guide.md in README

Stop after launch ready.
```

---

## Summary: 4-5 Prompts Best Quality

- **4 prompts if you combine 0+1 and 2+3:** 1) scaffolding+MVP, 2) full content+polish, 3) testing+launch (+ optional 4th for asset replacement)
- **5 prompts safest:** as listed above

**Best methods for compatibility:** Three.js 0.160.0 ES modules via importmap, OrbitControls from addons, DRACOLoader optional, fitCanvas DPR max 2, ResizeObserver, WebGL context lost handling, pointer lock with user gesture, touch handling, reduced motion, GameShell lifecycle.

**Best aesthetic low-poly 3D:** flatShading true, 3 materials max pastel palette #E8E8E8/#FFB5C2/#7DD3C0, no textures, FogExp2, basic shaders (UV scroll belt, emissive pulse synergy, pollution lerp), instancing, LOD, 1024 shadows toggle, procedural placeholders then Kenney GLB.

**Best results:** Follow this 4-5 prompt plan, verify after each per 08-checklist.md, point Claude at docs/kitty/ folder each time.

