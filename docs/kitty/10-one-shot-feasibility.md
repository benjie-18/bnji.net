# Can Claude Fable 5.1 Do Full Implementation in One Go?

**Short answer: No — not reliably. Phased approach required. One-shot full implementation would likely fail or produce unmaintainable code.**

## 10.1 Complexity Analysis

**Full game scope:**
- 13 files new + 4 modified + 12 GLB assets + 12 icons + CSS
- ~3000-5000 lines TS (content config 500 lines, formulas 200, save 300, rules 800, Three.js client 1500, verifier 100, Astro page 200)
- Three.js low-poly with InstancedMesh, OrbitControls, PointerLockControls, GLTFLoader, Draco, belt shader, fog, minimap, raycaster, grid placement, drag, offline calc, save throttling, prestige 5 layers, synergies, pollution, accessories gacha, achievements, leaderboard, mobile touch, potato mode, accessibility fallback
- Save system with migration, compact encoding <16KiB, CAS conflict handling, IndexedDB queue
- Verifier with plausible check
- Testing: unit + e2e + manual

**Estimated tokens:** Full implementation ~50k-80k tokens output, plus context 30k input (docs/kitty/ total ~100KB ~25k tokens). One-shot would need ~100k+ tokens, exceeding typical single response limits and risking truncation.

**Claude Fable 5.1 capabilities:**
- Strong at code generation, but struggles with:
  - Large multi-file refactors in one go (loses track of file dependencies)
  - Three.js scene graph + instancing + controls + save integration (many subtle bugs: context lost, DPR, pointer lock permission, instanceMatrix update, shader uniform)
  - Save size <16KiB enforcement (needs iterative testing)
  - D1 write budget math and throttling (needs careful debouncing)
  - Verifier wiring (register-all.ts + SCORE_VERIFIER_GAMES + test) — easy to miss one and cause 503 outage (happened with Stack)
  - Asset pipeline (GLB Draco, public folder)

**One-shot risks:**
- Context window overflow → truncated files, missing imports
- No verification between steps → build fails, tsc errors, save too big, verifier not registered, leaderboard page not prerendered
- No manual testing → WebGL context lost not handled, mobile touch broken, offline progress wrong
- Unmaintainable: all content hardcoded, not data-driven, hard to add new machines
- No phased feedback → owner can't adjust balancing early

## 10.2 What Claude CAN Do in One Go

- **Phase 0 scaffolding only (1 day scope):** catalog entry, empty Astro page GameShell, Three.js ground + orbit, save schema v1, local save 10s, cloud throttled 2min, verifier skeleton. This is ~500-800 lines, 6 files, feasible in one go with verification.
- **Single system:** e.g., just data-driven content config + formulas + save schema, or just Three.js client with instancing.

## 10.3 Recommended Approach for Claude

**Phased, verified, with checklist after each phase:**

**Phase 0 (1 go):** Scaffolding per 09-claude-prompt.md — 6 files, build passes, tsc 0 errors, save <16KiB.

**Phase 1 (1 go):** MVP Core Loop — 5 machines, grid placement, manual drag + conveyor, pollution, money, HUD, parcel buy, offline, manual save. Test save/load/offline.

**Phase 2 (1 go):** Prestige + Content — Rebirth, Evolution, Kitception, Factory reset, Move out, 12 machines full, synergies, parcel upgrades.

**Phase 3 (1 go):** Polish + 3D — InstancedMesh, belt shader, fog, minimap, achievements, accessories gacha, sound, potato mode, mobile, verifier, leaderboard.

**Phase 4 (1 go):** Testing + Launch — unit tests, e2e, manual, build verification, status available.

Each phase ~1 Claude session, with `npm run build` + `tsc` + manual test between. Total 4-5 sessions, ~3 weeks AI-assisted, vs 1 session high risk of failure.

## 10.4 Prompt Strategy for One-Shot Attempt (Not Recommended)

If you still want to try one-shot, use prompt in 09-claude-prompt.md but change last line to "Do full implementation". Expect:
- Build likely fails first try, need 2-3 follow-up fixes
- Save size likely >16KiB, need compact encoding iteration
- Verifier likely missing import, need fix
- Three.js controls likely buggy, need iteration
- Mobile likely broken

Better to explicitly say "Phased, Phase 0 only" for first session.

## 10.5 Verdict

**Can it do full implementation in one go?** Technically possible with very large context and many tokens, but **not reliably, not maintainably, not verifiably**. High risk of 503 outage, save too big, D1 write spam, WebGL bugs, unmaintainable hardcoded content.

**Should it?** No. Use phased approach per 08-checklist.md. Point Claude at docs/kitty/ folder, start with Phase 0 prompt in 09-claude-prompt.md, verify, then Phase 1, etc.

**For Claude Fable 5.1 specifically:** It's good at following detailed plans like 03-implementation-plan.md, but needs verification after each phase. One-shot full game = 3 weeks work in one response = too much.

**Final recommendation:** 4-5 phased Claude sessions, each with build + tsc + manual test, per checklist. That's how existing games (Stack, Chess, PvP Minesweeper) were built — iteratively, not one-shot.

