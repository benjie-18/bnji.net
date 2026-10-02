# Kitty Factory — Overview

**Game:** Tycoon incremental idle like Roblox Sell Lemons (BloxByte Games). Player starts small factory, basic kitty production machine, limited money. Buy/build/upgrade kitty making systems (mom, hatchery, adoption center, artist, chef, printer, sculptor, vending, stickers, bakery, plushie, 3D printer, robot assembler), produce kitties through stages (creation → upgrade(s) → sell), drag manually or buy conveyors, sell for money, expand factory parcels, pollution reduces efficiency `E=100%*e^(-k*pollution²)`, parcel upgrades reduce pollution.

Prestige layers (like Sell Lemons):
- Rebirth → treats based on total kitties produced → factory-wide upgrades not reset
- Evolution → super treats → better kitties (0=black 1=brown 5=white 10=orange) + traits (tiny→godlike) scaling formula
- Kitception → incredible treats → race (Persian, Siamese, Maine Coon... → anthropomorphic, alien)
- Factory reset → factory credits → factory type (garage, small factory, factory, industrial complex)
- Move out → location (village, town, city, planets)
- Accessories (hat, glasses, party hat) late game stats bonus, gacha with special currency
- Synergies: Mom→Hatchery +10%, Artist→Printer auto, Chef→Bakery +25% value, Sculptor→3D Printer quality
- Tracking: Money/s, Kitties/s, Value/kitty, Efficiency, Pollution, Production time, Best kitty value, Game time, Idle/active time
- Leaderboard, achievements

**Goals:**
- Low-poly 3D hybrid: third-person orbit default, top-down build mode, optional first-person inspect. Playable at scale (12 machine types, 10x10 parcels, 100 machines, 200 kitties on belts).
- Integrated in existing `bnji.net` games infra: `/games/kitty-factory/` as `bnji.kitty-factory`, uses GameShell, mountGameLifecycle, mountGameSession, game_saves (25×16KiB), leaderboard verifier, tracking, admin.
- Data-driven: adding machine/kitty/trait/race/factory type/location/accessory = 1 config entry + 1 GLB.
- Frequent saves: manual + auto every 2 min, local IndexedDB every 10s, cloud throttled, viable for low DAU (<50) within D1 Free 100k writes/day (~37k/day for 20 DAU).
- Free-only: Three.js MIT, Kenney CC0, Quaternius CC0, no paid services.
- Easy updates.

**Non-Goals:**
- Multiplayer, physics, monetization, separate Worker for MVP, high-poly.

**Constraints Verified:**
- `src/data/games.ts` validates IDs `bnji.<kebab>`, description ≤12 words, exactly one destination for available.
- `SCORE_VERIFIER_GAMES` must include new game, else 503 verifier_unavailable. Test `score-verifier-registry.test.ts` fails if drift.
- `register-all.ts` is single wiring point.
- Save: 16KiB max, 25 slots, slotId regex `^[a-z0-9][a-z0-9._-]{0,31}$`, CAS 409 conflict, IndexedDB queue 3 retries.
- D1 Free: 100k writes/day shared, heartbeats 1/min, 45s min interval, 65s clamp, retention sweep 60 rows/table/hour ~33k/day.
- KV Free: 1k writes/day — must not use for saves.
- GameShell lifecycle, webgl2 probe, context lost handling.

**Free Stack:**
- Engine: Three.js 0.160.0 MIT (justified per DEPENDENCY-POLICY.md Tier 2), OrbitControls, GLTFLoader, DracoLoader optional.
- Models: Kenney factory-kit, city-kit, animal-kit CC0, Quaternius Ultimate Low Poly CC0, KayKit.
- Icons: 64×64 PNG Kenney or local Stable Diffusion.
- Audio: Kenney sci-fi, ui-audio, freesound CC0, Web Audio optional.

**Player Count:** Low, not many players, so frequent saves viable.

**Update Ease:** Data-driven config, save migration via `schema_version`, no D1 migration needed.

**Hosting Decision:** Integrated `/games/kitty-factory/` recommended for MVP. Vanity `kitty.bnji.net` route to same Worker can be added later, same codebase, no separate Worker needed. See `01-research-hosting-2d-vs-3d.md`.

**Camera Decision:** Hybrid, not pure FP. Orbit default, top-down build, optional FP inspect. See `02-lowpoly-3d-first-third-person.md`.

