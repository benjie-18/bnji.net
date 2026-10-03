# Kitty Factory — Asset Pipeline (Free Only)

## 6.1 Models — Low-Poly Free CC0

**Sources:**
- Kenney Factory Kit: https://kenney.nl/assets/factory-kit — conveyor, machines, crates, 100+ GLB
- Kenney City Kit Suburban: buildings for factory types
- Kenney Animal Kit: base for kitty (or custom capsule)
- Quaternius Ultimate Low Poly: https://quaternius.com/ — animals, accessories, 1000+ models CC0
- KayKit: https://kaylousberg.itch.io/ — factory, city
- Poly Pizza: https://poly.pizza/ — CC0 low-poly

**Selection for 12 machines:**
- mom: Kenney factory-kit `factory_building` or custom
- hatchery: `machine_press`
- artist: `table`
- printer: `printer`
- adoption: `building_shop`
- chef: `oven`
- bakery: `factory_machine`
- sculptor: `workbench`
- vending: `vending_machine`
- stickers: `machine_cutter`
- plushie: `sewing_machine`
- 3d-printer: `3d_printer`
- robot-assembler: `robot_arm`

**Conversion:**
```bash
npm install -g @gltf-transform/cli
gltf-transform draco input.glb output.glb --encode
# or
npx gltf-pipeline -i input.glb -o output.glb -d
```
Target 5-30KB per GLB.

**Place:** `public/games/kitty/` — served as static, not counted against Worker req (per GAMES-OPERATIONS.md static assets don't consume Worker invocation quota).

**Size budget:** 12×20KB=240KB + 5 accessories×5KB=25KB total <500KB.

**Material library:** `src/game/kitty-materials.ts` — 3-4 THREE.MeshStandardMaterial with palette pastel, metallic. New machine reuses same materials, tint via `material.color` or InstancedBufferAttribute.

## 6.2 Icons — 64×64 PNG

- Kenney UI, or AI generated via local Stable Diffusion free: prompt "cute chibi kitty factory machine icon, isometric, pastel, transparent background, 64x64"
- Place `public/games/kitty/icons/`
- Use for build toolbar

## 6.3 Audio — Optional Free CC0

- Kenney Sci-Fi Sounds, UI Audio, freesound.org CC0
- Place `public/games/kitty/sfx/`
- Web Audio, play only after user gesture, respect audio capability, toggle in settings

## 6.4 No R2 Needed

Public folder is enough. R2 free tier 10GB exists but not needed per free-only constraint.

## 6.5 Adding New Machine Asset

1. Download GLB from Kenney/Quaternius
2. Draco compress
3. Drop to `public/games/kitty/`
4. Add entry to MACHINES in `kitty-content.ts` with model path
5. Build, test, push

No code change.

