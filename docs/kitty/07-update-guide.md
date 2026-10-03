# Kitty Factory — Update Guide (Easy Updates)

Goal: Adding more machines, kitties, levels, expansions = 1 config entry + 1 GLB, no logic change.

## 7.1 New Machine (2 min)

1. Add to `src/data/kitty-content.ts` MACHINES array:
```ts
{ id:'new-machine', name:'New Machine', desc:'Does X', baseCost:100000, costMult:1.3, baseTime:5, basePollution:3, baseValue:15, category:'creation', model:'/games/kitty/new-machine.glb', icon:'/games/kitty/icons/new-machine.png', upgrades:[], synergies:[] }
```
2. Add GLB + icon to `public/games/kitty/` and `public/games/kitty/icons/`
3. `npm run build` → test locally `npm run preview`
4. Push

No other files.

## 7.2 New Kitty Color / Trait / Race

1. Add entry to KITTY_COLORS / TRAITS / RACES array in `kitty-content.ts`
```ts
{ level:11, id:'rainbow', name:'Rainbow', mult:60 }
```
2. If race needs model variant, add GLB or use tint
3. Build, push

Formulas auto-scale: colorMult = 1+level^1.85*0.45, traitMult=1.65^tier, raceMult=1.75^tier

## 7.3 New Factory Type / Location

1. Add entry to FACTORY_TYPES / LOCATIONS
```ts
{ tier:4, id:'mega-factory', name:'Mega Factory', mult:30, k:0.00001 }
```

## 7.4 New Accessory

1. Add entry to ACCESSORIES
```ts
{ id:'sunglasses', name:'Sunglasses', bonus:15, weight:20, model:'/games/kitty/acc/sunglasses.glb' }
```

## 7.5 New Level

No entry needed — formula handles infinite levels: cost = base * 1.15^owned. If you want cap, add maxLevel field.

## 7.6 New Expansion (Parcel)

Change GRID size or add new parcel type in config. Parcel cost formula base*2.5^owned.

## 7.7 New Currency / Prestige Layer

1. Add to currencies in save schema with default 0 in migrate()
2. Add to PRESTIGE requirements
3. Add UI button in prestige panel
4. Bump SAVE_VERSION, add migrate step

## 7.8 Balancing

Change numbers in `kitty-content.ts` or override via `site_settings` D1 table key `kitty-balance` JSON, read via `/api/config`, merge over defaults. Allows hotfix without deploy.

## 7.9 Save Migration

If breaking change:
1. Bump SAVE_VERSION in `kitty-save.ts`
2. Add migrate step:
```ts
if (save.v === 2) { save.currencies.newCurrency ??= 0; save.v = 3; }
```
3. Old saves auto-migrate on load.

No D1 migration needed.

## 7.10 Checklist

- [ ] Config entry added
- [ ] GLB + icon added to public/
- [ ] Save migration if needed
- [ ] Size <16KiB for 100 machines (unit test)
- [ ] Build passes
- [ ] Manual test save/load/offline
- [ ] Push

All free, no paid services.

