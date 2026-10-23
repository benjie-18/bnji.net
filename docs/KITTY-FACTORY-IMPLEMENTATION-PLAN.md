# Kitty Factory — Complete Implementation Plan

**Version:** 1.0 — 2026-10-02  
**Status:** Plan only, no code yet  
**Base repo:** `benjie-18/bnji.net` branch `arena/01a0fe13-bnji-net` — Astro 7 + Cloudflare Workers Free + D1 `bnji-board` + KV `BOARD_KV` + DOs `GAME_ROOMS`, `DM_CONVERSATIONS`, `PRESENCE`  
**Goal:** Build low-poly 3D first/third-person hybrid tycoon idle game **integrated** as `bnji.kitty-factory` at `/projects/games/kitty-factory/`, playable at target scale, easy to update (more machines, kitties, levels, expansions), free-only, frequent saves (manual + auto every 2 min) with low DAU.

This plan is written so a competent developer can build the entire game from this document alone, without asking follow-ups.

---

## 1. Goals and Non-Goals

### Goals
- Tycoon incremental idle like Roblox Sell Lemons (BloxByte Games): buy income sources, upgrade, automate with conveyors/managers, prestige layers.
- Low-poly 3D, hybrid camera: third-person orbit default, top-down build mode, optional first-person inspect. Playable on desktop + mobile.
- Fully integrated in existing games infra: uses `GameShell`, `mountGameLifecycle`, `mountGameSession`, `game_saves` (25 slots × 16KiB), leaderboard verifier, tracking, admin panel, glass UI tokens.
- Data-driven content: adding machine/kitty/trait/race/factory type/location/accessory = 1 config entry + 1 GLB (or tint), no logic change.
- Frequent saves viable: local IndexedDB every 10s, cloud every 2 min + manual, within Free D1 100k writes/day for <50 DAU.
- Free-only: Three.js MIT, Kenney CC0, Quaternius CC0, no paid services, no R2 needed (assets in `/public`).
- Easy updates: new content = config + asset, save migration via `schema_version`, no D1 migration.

### Non-Goals
- Multiplayer (no rooms needed, but infra supports it if later).
- Real-time physics (kitties don't need rigidbodies, just queue counts).
- Monetization, Robux, ads.
- Separate Worker or subdomain for MVP (vanity `kitty.bnji.net` route can be added later to same Worker).
- High-poly PBR, shadows ultra, post-processing.

### Constraints Verified from Repo
- `defineGameCatalog` in `src/data/games.ts` validates stable IDs `bnji.<kebab>`, description ≤12 words, exactly one destination for `available` (href xor labHref). Never rename ID after scores exist.
- `SCORE_VERIFIER_GAMES` in `src/data/game-adapters.ts` must include new game, else leaderboard page renders but submissions fail 503. Test `tests/score-verifier-registry.test.ts` fails if drift.
- `register-all.ts` is single wiring point for verifiers. Missing import = invisible verifier = outage (Stack outage 2026-10).
- Save: `PLAYER_SAVE_MAX_BYTES = 16*1024`, `MAX_SLOTS = 25`, `MAX_SCHEMA_VERSION = 10000`, slotId regex `^[a-z0-9][a-z0-9._-]{0,31}$`, gameId regex `^bnji\.[a-z0-9]+(?:-[a-z0-9]+)*$`. API `PUT /api/games/saves` uses CAS `expectedRevision`, returns 409 conflict with current. Browser `src/scripts/game-saves.ts` has IndexedDB `bnji-game-saves-v1`, pending queue, 3 retries.
- D1 Free: 100k writes/day shared. Heartbeats 1/min visible, 45s min interval server-side, 65s clamp. Retention sweep 60 rows/table/hour max, ~33k writes/day.
- KV Free: 1k writes/day — saves/heartbeats must NOT use KV (they don't).
- `GameShell` expects `gameId`, `title`, `instructions`, `initialState`, optional `boardHref`. Pause/resume events `bnji:game-pause/resume`.
- `game-runtime.ts` probes `webgl2` via throwaway canvas, passes `webgl2` fact. Must handle `webglcontextlost`.
- Admin: `/admin` already shows Games & play totals, retention config.

---

## 2. Game Design — Complete Spec

### 2.1 Inspiration: Sell Lemons Mapping
- Sell Lemons Income Sources (Lemon Stand → LemonX, cooldown + managers automate + speed upgrades) → Kitty machines (mom, hatchery, adoption center, artist, chef, printer, sculptor, vending, stickers, bakery, plushie, 3D printer, robot assembler)
- Rebirth (lose cash/sources, keep fruits/buttons/robux, gain Investors, total Investors including spent counts) → Rebirth: lose money/machines, keep factory parcels upgrades?, gain Treats based on total kitties produced (including spent)
- Evolution (10 fruits loop +1, x42 global speed, requires total Investors) → Evolution: kitty color rarity 0=black 1=brown 5=white 10=orange, trait scaling tiny→godlike, super treats, speed mult
- Kitception (race: Persian, Siamese, Maine Coon, Ragdoll, British Shorthair, Bengal, Sphynx, Scottish Fold, American Shorthair, Russian Blue, Abyssinian, Birman, Burmese, Norwegian Forest Cat, Turkish Angora, Exotic Shorthair, Himalayan, Siberian, Munchkin, Devon Rex → anthropomorphic, alien) → incredible treats
- Factory reset (garage, small factory, factory, industrial complex) → factory credits
- Move out (village, town, city, planets) → location multiplier
- Synergies: Mom→Hatchery +10%, Artist→Printer auto, Chef→Bakery +25% value, Sculptor→3D Printer quality
- Accessories (hat, glasses, party hat) → late game stats bonus, gacha with special currency
- Tracking: Money/s, Kitties/s, Value/kitty, Factory efficiency, Pollution, Production time, Best kitty value, Game time, Idle/active time

### 2.2 Core Loop
```
Start: small factory (1 parcel), basic kitty production machine (mom), $100
Loop:
  1. Machine produces kitties through stages: creation → upgrade(s) → sell
  2. Each stage independently upgradable, has pollution cost
  3. Kitties require resources, pass through line. Can drag manually to next stage OR buy conveyor belts (automation)
  4. Sell completed kitties → money
  5. Money → buy new machines, expand factory (buy parcels), increase production speed
  6. Pollution: Efficiency = 100% * e^(-k * pollution^2). Lowers overall output
  7. Parcel upgrade reduces pollution modifier for machines inside
  8. Optimize layout for money/min
  9. Factory continues while managing (offline progress)
  10. Prestige: Rebirth (treats), Evolution (super treats), Kitception (incredible treats), Factory reset (credits), Move out (location)
  11. Accessories gacha late game
  12. Achievements + leaderboard (best kitty value)
```

### 2.3 Machines (Data-Driven)
Each machine:
- `id`, `name`, `description`, `baseCost`, `costMult` (1.15), `baseTime` (sec), `basePollution`, `baseValue`, `category` (creation, processing, finishing, selling)
- `upgrades`: array of {level, cost, timeReduction, pollutionAdd, valueMult}
- `model`: GLB path, `icon`: PNG
- `synergies`: [{with: machineId, bonus: 0.1, type: 'production'|'value'}]
- `requires`: optional prerequisite machine

Initial set (MVP 5, full 12):
- mom (creation, low pollution, spawns base kitty)
- hatchery (processing, needs mom)
- artist (creation, draws kitties, synergy with printer)
- printer (processing, prints artist designs)
- adoption center (selling, final stage)
Full adds: chef, bakery, sculptor, vending, stickers, plushie, 3D printer, robot assembler

### 2.4 Kitty Definition (Data-Driven)
Kitty instance:
- `colorLevel` 0-10+ (0=black 1=brown 5=white 10=orange, scaling formula)
- `traitLevel` 0-14 (tiny, small, medium, big, large, giant, strong, smart, wise, pretty, colossal, planetary, solar, universal, godlike)
- `raceId` (persian, siamese, ... alien, anthro)
- `accessories`: array of accessoryIds
- `value`: computed

Value formula:
```
colorMult = 1 + level^1.85 * 0.45
traitMult = 1.65^traitLevel
raceMult = 1.75^raceTier
accessoryMult = 1 + sum(bonus)/100
synergyMult = 1 + 0.1 per active synergy in same parcel
efficiency = exp(-k_eff * pollution^2)
value = 10 * colorMult * traitMult * raceMult * accessoryMult * synergyMult * efficiency
```

### 2.5 Pollution
- Global pollution per parcel + per machine
- `k_base = 0.00008`, parcel upgrade reduces: `k_eff = k_base * 0.7^parcelLevel`
- Efficiency per parcel: `exp(-k_eff * pollution^2)`
- Overall factory efficiency = average parcel efficiency weighted by machines
- Visual: fog tint green→brown, machine emissive dimming

### 2.6 Conveyors
- Manual drag: click kitty → drag to next machine (pointer events)
- Conveyor belt: buy belt segment, auto moves kitties at speed. In 3D: visual belt with UV scroll, kitties queue counts not individual physics
- Implementation: grid-based, each cell can have belt direction N/S/E/W, speed

### 2.7 Parcels and Expansion
- Grid 10x10 per parcel initially, 1 parcel. Buy new parcel costs `base * 2.5^owned`
- Each parcel has `pollution`, `kLevel`, `machines[]`, `belts[]`
- Parcel upgrade costs money, reduces k

### 2.8 Currencies
- Money: temporary factory progression (reset on rebirth+)
- Treats: rebirth, based on total kitties produced
- Super Treats: evolution, based on total kitties + evolution level
- Incredible Treats: kitception, based on total kitties^0.28
- Factory Credits: factory reset, based on best value
- Location Points: move out, based on total money

Formulas (tunable via config):
```
treats = floor((totalKitties / 1e6)^0.5)
superTreats = floor(log10(totalKitties/1e9 +1) * (evolution+1) * 0.5)
incredible = floor((totalKitties^0.28)/150)
credits = floor(log10(bestValue/1000 +1) * factoryTier)
```

### 2.9 Prestige Layers (Sell Lemons style)
- Rebirth: requires $1e6 money, resets money/machines (keep parcels? design choice: keep parcels but reset machines), gain treats → factory-wide upgrades (production speed, pollution reduction, conveyor speed)
- Evolution: requires total treats + total kitties, resets rebirth, gain super treats → better kitties (color/trait unlock)
- Kitception: requires super treats, resets evolution, gain incredible → race unlock
- Factory reset: requires incredible, resets kitception, gain credits → factory type (garage→industrial complex) with global mult
- Move out: requires credits, resets factory, gain location mult → village→planets

Each prestige has confirmation popup like Sell Lemons.

### 2.10 Accessories Gacha
- Late game, special currency yarn balls (from achievements or best kitties)
- Weighted random: common hat 50%, rare party hat 5%, etc.
- Pity timer: guaranteed rare after 20 rolls
- Stats bonus only after certain factory level to avoid early imbalance
- Cosmetic + small value bonus

### 2.11 Achievements
- Data-driven list: {id, name, desc, condition: {type, target}, reward}
- Types: total kitties, best value, money, prestige count, machines placed, etc.
- Reward: yarn balls or permanent mult

### 2.12 Leaderboard
- Mode `default`: best kitty value (hardest to cheat, like Stack's tie-break)
- Optional modes: `kitties-per-sec`, `money-per-sec` (more cheat-prone, but okay for low DAU)
- Verifier checks plausible value from save proof (see §5)

---

## 3. Data-Driven Architecture

### 3.1 File Structure (New + Modified)

**New files:**
```
src/data/kitty-content.ts          // All content tables, single source of truth
src/game/kitty-rules.ts            // Pure logic, no Three.js, no DOM
src/game/kitty-formulas.ts         // Cost, value, pollution, prestige formulas
src/game/kitty-save.ts             // Save schema, migrate, compact encode/decode
src/pages/projects/games/kitty-factory.astro // GameShell page
src/scripts/games/kitty-factory.ts // Three.js client, lifecycle, UI, save handling
src/server/game-adapters/kitty-factory.ts // Score verifier
public/games/kitty/                // GLB models, icons, audio
  mom.glb, hatchery.glb, ...
  icons/mom.png, ...
  sfx/
src/styles/kitty.css               // Optional, or extend games.css
```

**Modified files:**
```
src/data/games.ts                  // Add bnji.kitty-factory entry, description ≤12 words
src/data/game-adapters.ts          // Add 'bnji.kitty-factory' to SCORE_VERIFIER_GAMES, MODE_LABEL
src/server/game-adapters/register-all.ts // import './kitty-factory'
package.json                       // Add three@^0.160.0 (MIT) with justification in GAMES-DECISIONS.md
src/styles/tokens.css              // Add --kitty-* tokens if needed
docs/GAMES-DECISIONS.md            // Document why Three.js justified
```

### 3.2 Content Config Example (Complete)

```ts
// src/data/kitty-content.ts
export const MACHINES = [
  { id:'mom', name:'Kitty Mom', desc:'Spawns base kitties', baseCost:10, costMult:1.15, baseTime:2, basePollution:1, baseValue:1, category:'creation', model:'/games/kitty/mom.glb', icon:'/games/kitty/icons/mom.png', upgrades:[
    {level:1, cost:50, timeMul:0.9, pollAdd:0.5, valueMul:1.2},
  ], synergies:[{with:'hatchery', bonus:0.1}] },
  { id:'hatchery', name:'Hatchery', desc:'Hatches kitties', baseCost:100, costMult:1.18, baseTime:3, basePollution:2, baseValue:2, category:'processing', model:'/games/kitty/hatchery.glb', icon:'/games/kitty/icons/hatchery.png', requires:'mom', synergies:[] },
  // ... 10 more
] as const

export const KITTY_COLORS = [
  { level:0, id:'black', name:'Black', mult:1 },
  { level:1, id:'brown', name:'Brown', mult:1.45 },
  { level:5, id:'white', name:'White', mult:12 },
  { level:10, id:'orange', name:'Orange', mult:45 },
] as const

export const TRAITS = [
  { level:0, id:'tiny', name:'Tiny', mult:1 },
  { level:1, id:'small', name:'Small', mult:1.65 },
  // ... up to godlike 14
] as const

export const RACES = [
  { tier:0, id:'persian', name:'Persian', mult:1 },
  // ... 20 more, last alien 50x, anthro 80x
] as const

export const FACTORY_TYPES = [
  { tier:0, id:'garage', name:'Garage', mult:1, k:0.00008 },
  { tier:1, id:'small-factory', name:'Small Factory', mult:2, k:0.00006 },
  { tier:2, id:'factory', name:'Factory', mult:5, k:0.00004 },
  { tier:3, id:'industrial', name:'Industrial Complex', mult:12, k:0.00002 },
] as const

export const LOCATIONS = [
  { tier:0, id:'village', name:'Village', mult:1 },
  { tier:1, id:'town', name:'Town', mult:3 },
  { tier:5, id:'mars', name:'Mars', mult:100 },
] as const

export const ACCESSORIES = [
  { id:'hat', name:'Hat', bonus:5, weight:50, model:'/games/kitty/acc/hat.glb' },
  { id:'party-hat', name:'Party Hat', bonus:25, weight:5, model:'/games/kitty/acc/party-hat.glb' },
] as const

export const PARCEL_COST = { base:500, mult:2.5 }
export const PARCEL_UPGRADE_COST = { base:1000, mult:2.2, kReduction:0.7 }

export const PRESTIGE = {
  rebirth: { requireMoney:1e6, formula: (totalKitties:number)=> Math.floor((totalKitties/1e6)**0.5) },
  evolution: { requireTreats:100, requireTotalKitties:1e9, formula: (totalKitties:number, evo:number)=> Math.floor(Math.log10(totalKitties/1e9+1)*(evo+1)*0.5) },
  // ...
}

export const ACHIEVEMENTS = [
  { id:'first-kitty', name:'First Kitty', desc:'Produce 1 kitty', cond:{type:'totalKitties', target:1}, reward:{yarn:10} },
] as const
```

All formulas in `kitty-formulas.ts` import this config, no hardcoded IDs elsewhere.

### 3.3 Adding New Content (Update Process)

**New machine:**
1. Add entry to `MACHINES` array
2. Add GLB + icon to `public/games/kitty/`
3. Build, test, push — no other file changes

**New kitty color/trait/race:**
1. Add entry to respective array
2. If race needs model variant, add GLB or use tint

**New factory type/location:**
1. Add entry to `FACTORY_TYPES` / `LOCATIONS`

**New accessory:**
1. Add entry to `ACCESSORIES`

**New level:** No entry needed, formula handles infinite levels. If you want level cap, add `maxLevel` field.

**New expansion (parcel):** Change `GRID` size or add new parcel type.

All via config, no logic change.

---

## 4. Formulas — Complete and Tunable

```ts
// src/game/kitty-formulas.ts
export function machineCost(base:number, mult:number, owned:number) {
  return Math.floor(base * mult**owned)
}
export function productionTime(base:number, speedUpgrades:number, globalMult:number) {
  return base / (1 + speedUpgrades*0.2) / globalMult
}
export function pollutionEfficiency(kEff:number, pollution:number) {
  return Math.exp(-kEff * pollution**2) // 0..1
}
export function kEff(kBase:number, parcelLevel:number, reduction=0.7) {
  return kBase * reduction**parcelLevel
}
export function kittyValue(base=10, colorMult:number, traitMult:number, raceMult:number, accMult:number, synergyMult:number, eff:number) {
  return base * colorMult * traitMult * raceMult * accMult * synergyMult * eff
}
export function colorMult(level:number) { return 1 + level**1.85 * 0.45 }
export function traitMult(tier:number) { return 1.65**tier }
export function raceMult(tier:number) { return 1.75**tier }
export function treats(totalKitties:number) { return Math.floor((totalKitties/1e6)**0.5) }
export function superTreats(total:number, evo:number) { return Math.floor(Math.log10(total/1e9+1)*(evo+1)*0.5) }
export function incredible(total:number) { return Math.floor((total**0.28)/150) }
export function factoryCredits(bestValue:number, tier:number) { return Math.floor(Math.log10(bestValue/1000+1)*tier) }
```

All constants extracted to config for admin override via `site_settings` if needed.

---

## 5. Architecture — Client/Server Split

### 5.1 Client (Three.js)

**File: `src/scripts/games/kitty-factory.ts`**

- Dynamic import Three.js: `const THREE = await import('three')` + `OrbitControls` from `three/addons/controls/OrbitControls.js`, `GLTFLoader` from `three/addons/loaders/GLTFLoader.js`, `DRACOLoader` optional.
- Create scene, camera (Perspective 70°), renderer with antialias, shadowMap PCFSoft, canvas `[data-kitty-canvas]`.
- Renderer size: CSS box * devicePixelRatio (like Stack's `fitCanvas()`), aspect-ratio set in Astro.
- Controls:
  - Default: OrbitControls with damping, minDistance 2, maxDistance 50, maxPolarAngle Math.PI/2.1 (prevent below ground)
  - Build mode: top-down ortho toggle — camera position lerp to (0,50,0), look at factory center, controls enable pan, disable rotate
  - Inspect: click machine/kitty → close-up camera, or PointerLockControls for FP (requires user gesture, bind to double-click)
- Lighting: Ambient 0.6, Directional 0.8 with shadows 1024 res, Hemisphere light for low-poly.
- Ground: Plane with grid helper, parcels as boxes with different colors.
- Machines: `InstancedMesh` per type. Load GLB once, extract geometry/material, create InstancedMesh with count = max machines of that type (e.g., 100). Update instanceMatrix per machine position/rotation/scale. Use `InstancedBufferAttribute` for color tint if needed.
- Kitties: InstancedMesh single geometry (capsule + ears), count 200, position along belt via progress 0..1 lerp between belt segments. Don't simulate physics, just queue counts.
- Belts: Box geometry with UV scroll shader (time uniform). Direction via rotation.
- Pollution visual: per-parcel fog: `scene.fog = new THREE.Fog(color, near, far)` lerp color green→brown based on efficiency. Or per-parcel overlay plane with opacity.
- UI overlay (DOM, not 3D): glass panels from `tokens.css` — money, kitties/s, efficiency, best value, build buttons, prestige buttons, minimap canvas 2D top-down.
- Input: pointerdown for place/drag, raycaster for machine pick, keyboard WASD for FP, Esc to exit PointerLock.
- Lifecycle: `mountGameLifecycle` → `init` creates scene, `pause` stops RAF and controls, `resume` restarts, `destroy` disposes renderer, controls, removes listeners, closes audio.
- Tracking: `mountGameSession` already sends heartbeats, no extra code.
- Save handling: import `kitty-save.ts`, local IndexedDB via `game-saves.ts` API, cloud sync throttled.

**File: `src/pages/projects/games/kitty-factory.astro`**

- Import `GameShell`, `PageHeader`, `Layout`, `getGame`, `leaderboardHref`
- Instructions: "Build kitty factory, optimize layout, manage pollution, prestige..."
- GameShell `gameId="bnji.kitty-factory"` `capabilities` includes webgl
- Slot: `<canvas data-kitty-canvas>` + `<div data-kitty-ui>` + minimap + build toolbar
- Results slot: claim form like Stack (display name, submit)
- Script: `initGameShells()`, `mountGameLifecycle`, `mountGameSession`, `createKittyFactoryGame()`

### 5.2 Server

**File: `src/server/game-adapters/kitty-factory.ts`**

- `registerScoreVerifier('bnji.kitty-factory', async (claim, player, runtime) => {...})`
- Claim proof: `{ totalKitties, bestValue, saveHash, machineCounts }` or full save snapshot (bounded 2KB)
- Verification: recompute bestValue plausible from machineCounts + prestige levels using same formulas from `kitty-content.ts` + `kitty-formulas.ts`. Don't trust client value, compute max possible value given progression.
- Simple verifier for MVP: if `claim.score <= maxPlausibleValue` and `proof.totalKitties` matches save hash, accept. Return `{score: claim.score, tieBreak: ...}` where score = bestValue, tieBreak = totalKitties (more kitties wins ties).
- Mode: `default` only for MVP. Later add `kitties-per-sec`, `money-per-sec` if needed.
- No room authority needed (solo game).

**File: `src/data/games.ts`**

Add:
```ts
{
  id: 'bnji.kitty-factory',
  title: 'Kitty Factory',
  description: 'Build kitties, optimize factory, prestige endlessly.',
  status: 'in-development', // or 'available' when ready
  href: '/projects/games/kitty-factory/',
  capabilities: ['keyboard','pointer','touch','webgl','audio'],
  modes: ['default'],
}
```
Description must be ≤12 words — count: "Build(1) kitties,(2) optimize(3) factory,(4) prestige(5) endlessly.(6)" OK.

**File: `src/data/game-adapters.ts`**

Add `'bnji.kitty-factory'` to `SCORE_VERIFIER_GAMES`, add MODE_LABEL if needed.

**File: `src/server/game-adapters/register-all.ts`**

Add `import './kitty-factory';`

### 5.3 Save Schema — Complete

```ts
// src/game/kitty-save.ts
export const SAVE_VERSION = 2 // bump on breaking change

export type KittySave = {
  v: number
  money: number
  totalKitties: number
  bestValue: number
  gameTime: number // ms
  lastSeenAt: number // Date.now() for offline
  currencies: {
    treats: number
    superTreats: number
    incredible: number
    factoryCredits: number
    locationPoints: number
    yarn: number // gacha
  }
  prestige: {
    rebirth: number
    evolution: number
    kitception: number
    factoryReset: number
    moveOut: number
  }
  parcels: Array<{
    id: string
    x: number
    y: number
    level: number // pollution reduction
    pollution: number
    machines: Array<{ id:string, lvl:number, x:number, y:number, rot:0|90|180|270 }>
    belts: Array<{ x:number, y:number, dir:'n'|'s'|'e'|'w' }>
  }>
  upgrades: Record<string, number> // factory-wide upgrades from treats
  accessories: string[] // owned accessory ids
  achievements: string[] // unlocked ids
  stats: {
    moneyPerSec: number
    kittiesPerSec: number
    efficiency: number
  }
}

export function createNewSave(): KittySave { ... }

export function migrate(save:any): KittySave {
  if (!save.v || save.v < 1) save = {...createNewSave(), ...save, v:1}
  if (save.v === 1) {
    save.currencies.incredible ??= 0
    save.currencies.yarn ??= 0
    save.v = 2
  }
  return save as KittySave
}

export function compactEncode(save:KittySave): string {
  // Custom compact: parcels as "id:x,y,lvl,poll|machines: id,lvl,x,y,rot;..."
  // Use JSON.stringify then compress if needed, but keep <16KiB
  // For MVP, JSON.stringify is okay if you limit machines to 100
  return JSON.stringify(save)
}

export function compactDecode(str:string): KittySave {
  const parsed = JSON.parse(str)
  return migrate(parsed)
}

export function offlineProgress(save:KittySave, now=Date.now()): { moneyGain:number, kittiesGain:number } {
  const offlineMs = Math.min(now - save.lastSeenAt, 2*60*60*1000) // cap 2h
  if (offlineMs <= 0) return {moneyGain:0, kittiesGain:0}
  // Simulate: moneyPerSec * offlineMs/1000 * efficiency
  const eff = save.stats.efficiency
  return {
    moneyGain: save.stats.moneyPerSec * offlineMs/1000 * eff,
    kittiesGain: save.stats.kittiesPerSec * offlineMs/1000 * eff,
  }
}
```

**Save handling in client:**
- Local: `saveLocalProgress('bnji.kitty-factory','main', SAVE_VERSION, compactEncode(save))` every 10s
- Cloud: same but via `game-saves.ts` `put` with `expectedRevision`, throttled to every 2 min + manual button + prestige events
- On load: read local, then cloud, compare `updatedAt`, prompt conflict if needed (existing UI on `/projects/games/` page handles it)
- Manual save button: `data-kitty-save` → calls cloud save immediately, debounce 5s, show status in `data-player-live`

**Size check:** 100 machines × ~30B = 3KB, currencies ~200B, parcels ~500B, total <5KB JSON, well under 16KiB.

### 5.4 Leaderboard and Anti-Cheat

- Client submits `bestValue` as score, proof includes `totalKitties`, `machineCounts`, `prestige` levels, `saveHash` (hash of compact save)
- Server verifier recomputes max plausible bestValue: iterate machines, compute max value given upgrades and prestige mults, ensure claimed bestValue ≤ maxPlausible * 1.1 (10% tolerance for rounding)
- If plausible, store score = bestValue, tieBreak = totalKitties (or inverse for deeper runs)
- Idempotency key: `kitty-${runToken}` like Stack's `stk-`
- Auto-submit only when beats personal best (reuse `game-scores.ts` `beatsBest` logic)

---

## 6. Asset Pipeline — Free Only

**Models:**
- Source: Kenney `factory-kit` (CC0) — https://kenney.nl/assets/factory-kit — contains conveyor, machines, crates
- Kenney `city-kit-suburban` for buildings
- Quaternius low-poly animals for kitty base (or simple custom capsule)
- Convert to GLB with Draco compression via `gltf-pipeline` free, or use `npx gltf-transform draco`
- Place in `public/games/kitty/` — served as static, not counted against Worker requests (static assets don't count per GAMES-OPERATIONS.md)
- Size budget: 12 machines × 20KB = 240KB, accessories 5×5KB=25KB, total <500KB

**Icons:**
- 64×64 PNG for UI, from Kenney or AI generated via local Stable Diffusion (free)

**Audio (optional):**
- Kenney `sci-fi-sounds`, `ui-audio`, freesound.org CC0
- Web Audio, play only after user gesture, respect `audio` capability

**No R2 needed.** Public folder is enough.

---

## 7. UI/UX — Glass Design System

Reuse existing tokens from `src/styles/tokens.css` and `games.css`:

- HUD top: money, treats, superTreats, efficiency bar, money/s, kitties/s, best value
- Build toolbar left: machine list with cost, draggable, category tabs
- Parcel panel: buy parcel, upgrade pollution reduction
- Prestige panel: rebirth/evolution/kitception/factory reset/move out buttons with requirements and confirmation modal (like Sell Lemons)
- Minimap bottom-right: 2D canvas top-down view of parcels, click to teleport camera
- Manual save button + auto-save status (reuse `data-player-live`)
- Settings: sound toggle, potato mode (no shadows, reduced instances), reduced motion respect

All UI DOM, not 3D, for accessibility. Canvas only for 3D view.

---

## 8. Performance Optimizations

- InstancedMesh per machine type, per kitty type
- Frustum culling (Three.js default)
- LOD: far parcels use low-poly box, near use detailed
- Shadows: single DirectionalLight 1024, toggle off for potato mode
- Belt animation via shader uniform time, not per-mesh update
- RAF only when visible (via `mountGameLifecycle` pause)
- Resize handler like Stack's `fitCanvas()`: backing store = CSS box * DPR, max DPR 2
- WebGL context lost: pause, show message, offer 2D fallback (top-down build mode still works with Canvas2D)

Mobile:
- Touch: OrbitControls with one finger rotate, two finger zoom/pan, long press to place
- Joystick for FP if needed (optional)
- Reduce instance count to 50 machines max on mobile detection

---

## 9. Configuration and Balancing

- All constants in `kitty-content.ts` and `kitty-formulas.ts`
- Optional admin override via `site_settings` table: add key `kitty-balance` JSON, read via `/api/config`, merge over defaults. Allows hotfix without deploy.
- Document balancing in `GAMES-DECISIONS.md` when adding Three.js dependency (Tier 2 per DEPENDENCY-POLICY.md: runtime dependency needs justification — low-poly 3D tycoon needs Three.js, no vanilla alternative for instancing + orbit).

---

## 10. Testing Plan

**Unit tests (vitest):**
- `src/game/kitty-rules.test.ts`: machine cost, pollution efficiency, kitty value, prestige formulas, synergy detection
- `src/game/kitty-save.test.ts`: migrate v1→v2, compact encode/decode size <16KiB, offline progress calc
- `src/server/game-adapters/kitty-factory.test.ts`: verifier plausible check

**Workerd tests:**
- Existing `test:do` runs DO tests, no change needed

**E2E (Playwright):**
- `npm run test:e2e` already checks 390px mobile, 768px tablet, 1440px desktop, axe scans, keyboard-only, reduced motion, JS disabled
- Add test for `/projects/games/kitty-factory/` page loads, canvas exists, build button clickable, save button works

**Manual:**
- Local: `npm run preview` → `wrangler d1 migrations apply bnji-board --local` → `wrangler dev`
- Test save every 2 min, manual save, conflict prompt, offline progress (close tab, wait, reopen)
- Test WebGL context lost via `WEBGL_lose_context` extension
- Test mobile touch

**Score verifier registry test:**
- `tests/score-verifier-registry.test.ts` will fail unless `SCORE_VERIFIER_GAMES` includes `bnji.kitty-factory` and `register-all.ts` imports it — ensures no outage.

---

## 11. Deployment

1. Add Three.js: `npm install three@^0.160.0` (MIT, 145KB gz), document justification in `docs/GAMES-DECISIONS.md`
2. Add game entry in `src/data/games.ts`, status `in-development`
3. Create files listed in §3.1
4. `npm run build` → `verify-access.mjs` checks protected routes
5. `npx wrangler d1 migrations list bnji-board --local` — no new migration needed (save uses existing table)
6. `npm run preview` manual test
7. `git push origin arena/01a0fe13-bnji-net` → PR → merge to main → Cloudflare Workers Builds auto deploys
8. Verify `/projects/games/kitty-factory/` loads, `/api/games/saves` works, leaderboard page `/projects/games/kitty-factory/leaderboard/` exists (prerendered from `hasLeaderboard`)
9. Set status to `available` when ready

No new secrets, no new D1, no new KV, no new DO.

---

## 12. Update Process (Post-MVP)

**To add new machine:**
1. Add entry to `MACHINES` in `kitty-content.ts`
2. Add GLB + icon to `public/games/kitty/`
3. Bump `SAVE_VERSION` only if breaking, add migrate step
4. Build, test, push

**To add new kitty color/trait/race:**
1. Add entry to respective array

**To add new factory type/location:**
1. Add entry to `FACTORY_TYPES`/`LOCATIONS`

**To add new accessory:**
1. Add entry to `ACCESSORIES`

**To balance:**
1. Change numbers in `kitty-content.ts` or override via `site_settings` admin

All without D1 migration, without new Worker.

---

## 13. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| D1 100k writes/day exceeded by frequent saves | Throttle cloud to 2 min, local every 10s, low DAU <50 safe (37k/day). Monitor dashboard. |
| Save >16KiB | Compact encoding, queue counts not positions, 2 slots if needed, test size in unit test. |
| Three.js bundle bloat | Dynamic import only on kitty page, code-split, Draco GLB, no post-processing. |
| Mobile performance | Potato mode, instancing, LOD, 1024 shadows toggle, reduce instances. |
| WebGL context lost | Listen `webglcontextlost`, pause, show fallback top-down Canvas2D build mode. |
| Cheating leaderboard | Verifier recomputes max plausible value from proof, not trust client. |
| Pointer lock permission | Require user gesture, fallback to orbit. |
| Accessibility | Top-down build mode with buttons, keyboard controls, respect `prefers-reduced-motion`, semantic DOM UI. |
| Save conflict multi-tab | Existing CAS + conflict UI on `/projects/games/` page handles it. |

---

## 14. Phases — Recommended Timeline (AI-assisted)

**Phase 0 — Scaffolding (1 day):**
- Add catalog entry, empty Astro page with GameShell, Three.js scene with ground + orbit, save schema v1, local save every 10s.

**Phase 1 — MVP Core Loop (1 week):**
- 5 machines (mom, hatchery, artist, printer, adoption center), grid placement, manual drag + conveyor, pollution formula, money, money/s, kitties/s, efficiency HUD, parcel buy (1→2), save/load, offline progress, manual save button.

**Phase 2 — Prestige + Content (1 week):**
- Rebirth (treats), Evolution (super treats, color rarity), Kitception (incredible, race), Factory reset (credits), Move out (location). 12 machines full, synergies, parcel upgrades.

**Phase 3 — Polish + 3D (1 week):**
- InstancedMesh, belt shader, pollution fog, minimap, achievements, accessories gacha (yarn currency), sound toggle, potato mode, mobile touch, leaderboard verifier, leaderboard page.

**Phase 4 — Testing + Launch (2 days):**
- Unit tests, e2e, manual, build verification, set status available, deploy.

Total ~3 weeks for full game with AI, 2D fallback.

---

## 15. Appendix — Example Code Snippets

### Catalog entry
```ts
// src/data/games.ts
{
  id: 'bnji.kitty-factory',
  title: 'Kitty Factory',
  description: 'Build kitties, optimize factory, prestige endlessly.',
  status: 'in-development',
  href: '/projects/games/kitty-factory/',
  capabilities: ['keyboard','pointer','touch','webgl','audio'],
  modes: ['default'],
}
```

### Verifier skeleton
```ts
// src/server/game-adapters/kitty-factory.ts
import { registerScoreVerifier } from '../score-verifiers';
import { MACHINES } from '../../data/kitty-content';
import { maxPlausibleValue } from '../../game/kitty-formulas';

registerScoreVerifier('bnji.kitty-factory', async (claim) => {
  if (claim.modeId !== 'default') return null;
  const proof = claim.proof as { totalKitties:number, bestValue:number, machineCounts:Record<string,number> };
  if (!proof || typeof proof.bestValue !== 'number') return null;
  const max = maxPlausibleValue(proof.machineCounts);
  if (proof.bestValue > max * 1.1) return null; // cheat
  return { score: proof.bestValue, tieBreak: proof.totalKitties };
});
```

### Save throttling in client
```ts
let lastCloudSave = 0;
function maybeCloudSave(save:KittySave) {
  const now = Date.now();
  if (now - lastCloudSave < 120_000) return; // 2 min
  lastCloudSave = now;
  void saveCloudProgress('main', save); // uses game-saves.ts
}
```

### Three.js init
```ts
const THREE = await import('three');
const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true });
renderer.setSize(cssWidth*dpr, cssHeight*dpr, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
```

---

## 16. Verification Checklist Before Submitting

- [ ] `npm run build` passes, `verify-access.mjs` OK
- [ ] `tsc --noEmit` 0 errors
- [ ] `SCORE_VERIFIER_GAMES` includes `bnji.kitty-factory`
- [ ] `register-all.ts` imports `kitty-factory`
- [ ] Save size <16KiB for 100 machines (unit test)
- [ ] D1 write math for 50 DAU saving every 2 min <100k/day
- [ ] WebGL context lost handled
- [ ] Mobile touch tested
- [ ] Leaderboard page prerenders
- [ ] No new secrets, no paid deps, Three.js MIT justified
- [ ] Description ≤12 words
- [ ] GameShell lifecycle pause/resume stops RAF

---

This plan is complete, verified against repo files (`games.ts`, `game-adapters.ts`, `register-all.ts`, `player-store.ts`, `game-saves.ts`, `GAMES-OPERATIONS.md`, `CONFIGURATION.md`), adapted to low DAU + frequent saves + low-poly 3D integrated + easy updates + free-only.

