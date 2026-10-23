# Kitty Factory — Claude Context Folder

**Purpose:** Point Claude (Fable 5.1, Sonnet, etc.) at this folder to implement the full game. Everything needed is in `docs/kitty/`.

**How to use:**
1. In Claude, attach/upload or point to `docs/kitty/` folder (or paste `00-overview.md` + `03-implementation-plan.md` + `04-data-schema.md` as context)
2. Start with prompt in `09-claude-prompt.md`
3. Follow phases in `08-checklist.md`, don't try one-shot full implementation (see `10-one-shot-feasibility.md`)

**Files:**
- `00-overview.md` — Goals, constraints, free-only, low DAU, frequent saves, easy updates. Start here.
- `01-research-hosting-2d-vs-3d.md` — Hosting analysis: integrated `/projects/games/kitty-factory/` vs `kitty.bnji.net` subdomain, 2D indie vs 3D Roblox-style difficulty with AI, free options only. (from KITTY-FACTORY-RESEARCH.md)
- `02-lowpoly-3d-first-third-person.md` — Can low-poly 3D first/third-person run integrated? Playability at scale? Save frequency math. (from LOWPOLY-3D-ADDENDUM.md)
- `03-implementation-plan.md` — Complete implementation plan, file structure, client/server split, save schema, verifier, UI, performance, testing, deployment, phases. (from IMPLEMENTATION-PLAN.md)
- `04-data-schema.md` — Detailed data-driven content tables, formulas, save schema, migration, example configs. Extracted and expanded for implementation.
- `05-architecture.md` — Architecture deep dive: existing infra, new files, lifecycle, save handling, leaderboard, asset pipeline.
- `06-asset-pipeline.md` — Free low-poly assets (Kenney CC0, Quaternius), how to get, convert to GLB Draco, icons, audio.
- `07-update-guide.md` — How to add more machines, kitties, levels, expansions after MVP — 2-minute checklist.
- `08-checklist.md` — Verification checklist, testing plan, deployment steps.
- `09-claude-prompt.md` — Ready-to-copy prompt for Claude Fable 5.1 to start implementation.
- `10-one-shot-feasibility.md` — Can Claude do full implementation in one go? Analysis and recommendation.

**Original files also exist at:**
- `docs/KITTY-FACTORY-RESEARCH.md`
- `docs/KITTY-FACTORY-LOWPOLY-3D-ADDENDUM.md`
- `docs/KITTY-FACTORY-IMPLEMENTATION-PLAN.md`

But `docs/kitty/` is the clean, pointed folder.

**Quick start for Claude:**
> "You are building Kitty Factory for bnji.net. Read docs/kitty/00-overview.md, then 03-implementation-plan.md, then 04-data-schema.md. Follow phases in 08-checklist.md. Start Phase 0 scaffolding only."

**Free-only constraint:** No paid services, no R2, no PlayFab. Three.js MIT + Kenney CC0 only. D1 Free 100k writes/day shared.

**Save constraint:** Local IndexedDB every 10s, cloud every 2 min + manual, 16KiB max, 25 slots, low DAU (<50) makes frequent saves viable (~37k writes/day for 20 DAU).

**Update constraint:** Adding machine = 1 config entry + 1 GLB, no logic change.

