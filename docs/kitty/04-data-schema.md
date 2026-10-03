# Kitty Factory — Data Schema & Formulas

Complete data-driven tables and formulas. Both client and server import these. No hardcoded IDs elsewhere.

## 4.1 Machines

```ts
export type MachineDef = {
  id: string // kebab, unique
  name: string
  desc: string
  baseCost: number
  costMult: number // 1.15 typical
  baseTime: number // sec
  basePollution: number
  baseValue: number
  category: 'creation'|'processing'|'finishing'|'selling'
  model: string // /games/kitty/mom.glb
  icon: string // /games/kitty/icons/mom.png
  requires?: string // prerequisite machine id
  upgrades: Array<{level:number, cost:number, timeMul:number, pollAdd:number, valueMul:number}>
  synergies: Array<{with:string, bonus:number, type:'production'|'value'}>
}

export const MACHINES: MachineDef[] = [
  { id:'mom', name:'Kitty Mom', desc:'Spawns base kitties', baseCost:10, costMult:1.15, baseTime:2, basePollution:1, baseValue:1, category:'creation', model:'/games/kitty/mom.glb', icon:'/games/kitty/icons/mom.png', upgrades:[{level:1,cost:50,timeMul:0.9,pollAdd:0.5,valueMul:1.2},{level:2,cost:200,timeMul:0.8,pollAdd:1,valueMul:1.5}], synergies:[{with:'hatchery',bonus:0.1,type:'production'}] },
  { id:'hatchery', name:'Hatchery', desc:'Hatches kitties', baseCost:100, costMult:1.18, baseTime:3, basePollution:2, baseValue:2, category:'processing', model:'/games/kitty/hatchery.glb', icon:'/games/kitty/icons/hatchery.png', requires:'mom', upgrades:[], synergies:[] },
  { id:'artist', name:'Kitty Artist', desc:'Draws kitties', baseCost:500, costMult:1.2, baseTime:4, basePollution:1.5, baseValue:3, category:'creation', model:'/games/kitty/artist.glb', icon:'/games/kitty/icons/artist.png', upgrades:[], synergies:[{with:'printer',bonus:0.15,type:'production'}] },
  { id:'printer', name:'Printer', desc:'Prints kitties', baseCost:1000, costMult:1.22, baseTime:2.5, basePollution:3, baseValue:4, category:'processing', model:'/games/kitty/printer.glb', icon:'/games/kitty/icons/printer.png', requires:'artist', upgrades:[], synergies:[] },
  { id:'adoption', name:'Adoption Center', desc:'Sells kitties', baseCost:2000, costMult:1.25, baseTime:1, basePollution:0.5, baseValue:0, category:'selling', model:'/games/kitty/adoption.glb', icon:'/games/kitty/icons/adoption.png', upgrades:[], synergies:[] },
  // Full adds: chef, bakery, sculptor, vending, stickers, plushie, 3d-printer, robot-assembler
  { id:'chef', name:'Chef', desc:'Bakes kitties', baseCost:5000, costMult:1.25, baseTime:5, basePollution:2.5, baseValue:5, category:'creation', model:'/games/kitty/chef.glb', icon:'/games/kitty/icons/chef.png', upgrades:[], synergies:[{with:'bakery',bonus:0.25,type:'value'}] },
  { id:'bakery', name:'Bakery', desc:'Food kitties', baseCost:8000, costMult:1.26, baseTime:3, basePollution:3, baseValue:6, category:'processing', model:'/games/kitty/bakery.glb', icon:'/games/kitty/icons/bakery.png', requires:'chef', upgrades:[], synergies:[] },
  { id:'sculptor', name:'Sculptor', desc:'Sculpts kitties', baseCost:15000, costMult:1.28, baseTime:6, basePollution:4, baseValue:8, category:'creation', model:'/games/kitty/sculptor.glb', icon:'/games/kitty/icons/sculptor.png', upgrades:[], synergies:[{with:'3d-printer',bonus:0.2,type:'value'}] },
  { id:'vending', name:'Vending Machine', desc:'Vends kitties', baseCost:20000, costMult:1.3, baseTime:2, basePollution:1, baseValue:7, category:'selling', model:'/games/kitty/vending.glb', icon:'/games/kitty/icons/vending.png', upgrades:[], synergies:[] },
  { id:'stickers', name:'Stickers Machine', desc:'Makes stickers', baseCost:30000, costMult:1.3, baseTime:1.5, basePollution:1.2, baseValue:5, category:'finishing', model:'/games/kitty/stickers.glb', icon:'/games/kitty/icons/stickers.png', upgrades:[], synergies:[] },
  { id:'plushie', name:'Plushie Machine', desc:'Makes plushies', baseCost:50000, costMult:1.32, baseTime:7, basePollution:3.5, baseValue:12, category:'finishing', model:'/games/kitty/plushie.glb', icon:'/games/kitty/icons/plushie.png', upgrades:[], synergies:[] },
  { id:'3d-printer', name:'3D Printer', desc:'Prints 3D kitties', baseCost:100000, costMult:1.35, baseTime:8, basePollution:5, baseValue:20, category:'processing', model:'/games/kitty/3d-printer.glb', icon:'/games/kitty/icons/3d-printer.png', requires:'sculptor', upgrades:[], synergies:[] },
  { id:'robot-assembler', name:'Robot Assembler', desc:'Assembles robot kitties', baseCost:250000, costMult:1.4, baseTime:10, basePollution:8, baseValue:35, category:'creation', model:'/games/kitty/robot-assembler.glb', icon:'/games/kitty/icons/robot-assembler.png', upgrades:[], synergies:[] },
]
```

## 4.2 Kitty Content

```ts
export const KITTY_COLORS = [
  { level:0, id:'black', name:'Black', mult:1 },
  { level:1, id:'brown', name:'Brown', mult:1.45 },
  { level:2, id:'gray', name:'Gray', mult:2.2 },
  { level:3, id:'tabby', name:'Tabby', mult:3.5 },
  { level:4, id:'calico', name:'Calico', mult:5.5 },
  { level:5, id:'white', name:'White', mult:12 },
  { level:6, id:'ginger', name:'Ginger', mult:18 },
  { level:7, id:'cream', name:'Cream', mult:25 },
  { level:8, id:'silver', name:'Silver', mult:32 },
  { level:9, id:'golden', name:'Golden', mult:40 },
  { level:10, id:'orange', name:'Orange', mult:45 },
] as const

export const TRAITS = [
  { level:0, id:'tiny', name:'Tiny', mult:1 },
  { level:1, id:'small', name:'Small', mult:1.65 },
  { level:2, id:'medium', name:'Medium', mult:2.72 },
  { level:3, id:'big', name:'Big', mult:4.48 },
  { level:4, id:'large', name:'Large', mult:7.39 },
  { level:5, id:'giant', name:'Giant', mult:12.18 },
  { level:6, id:'strong', name:'Strong', mult:20.08 },
  { level:7, id:'smart', name:'Smart', mult:33.11 },
  { level:8, id:'wise', name:'Wise', mult:54.6 },
  { level:9, id:'pretty', name:'Pretty', mult:90.01 },
  { level:10, id:'colossal', name:'Colossal', mult:148.4 },
  { level:11, id:'planetary', name:'Planetary', mult:244.6 },
  { level:12, id:'solar', name:'Solar', mult:403.4 },
  { level:13, id:'universal', name:'Universal', mult:665.1 },
  { level:14, id:'godlike', name:'Godlike', mult:1096.6 },
] as const

export const RACES = [
  { tier:0, id:'persian', name:'Persian', mult:1 },
  { tier:1, id:'siamese', name:'Siamese', mult:1.8 },
  { tier:2, id:'maine-coon', name:'Maine Coon', mult:3.2 },
  { tier:3, id:'ragdoll', name:'Ragdoll', mult:5.8 },
  { tier:4, id:'british-shorthair', name:'British Shorthair', mult:10.4 },
  { tier:5, id:'bengal', name:'Bengal', mult:18.7 },
  { tier:6, id:'sphynx', name:'Sphynx', mult:33.7 },
  { tier:7, id:'scottish-fold', name:'Scottish Fold', mult:60.6 },
  { tier:8, id:'american-shorthair', name:'American Shorthair', mult:109 },
  { tier:9, id:'russian-blue', name:'Russian Blue', mult:196 },
  { tier:10, id:'abyssinian', name:'Abyssinian', mult:353 },
  { tier:11, id:'birman', name:'Birman', mult:635 },
  { tier:12, id:'burmese', name:'Burmese', mult:1143 },
  { tier:13, id:'norwegian-forest', name:'Norwegian Forest', mult:2057 },
  { tier:14, id:'turkish-angora', name:'Turkish Angora', mult:3702 },
  { tier:15, id:'exotic-shorthair', name:'Exotic Shorthair', mult:6664 },
  { tier:16, id:'himalayan', name:'Himalayan', mult:11995 },
  { tier:17, id:'siberian', name:'Siberian', mult:21591 },
  { tier:18, id:'munchkin', name:'Munchkin', mult:38864 },
  { tier:19, id:'devon-rex', name:'Devon Rex', mult:69955 },
  { tier:20, id:'alien', name:'Alien', mult:125919 },
  { tier:21, id:'anthro', name:'Anthropomorphic', mult:226654 },
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
  { tier:2, id:'city', name:'City', mult:10 },
  { tier:3, id:'metropolis', name:'Metropolis', mult:30 },
  { tier:4, id:'moon', name:'Moon', mult:100 },
  { tier:5, id:'mars', name:'Mars', mult:350 },
  { tier:6, id:'europa', name:'Europa', mult:1200 },
] as const

export const ACCESSORIES = [
  { id:'hat', name:'Hat', bonus:5, weight:50, model:'/games/kitty/acc/hat.glb' },
  { id:'glasses', name:'Glasses', bonus:8, weight:40, model:'/games/kitty/acc/glasses.glb' },
  { id:'party-hat', name:'Party Hat', bonus:25, weight:5, model:'/games/kitty/acc/party-hat.glb' },
  { id:'bowtie', name:'Bowtie', bonus:12, weight:30, model:'/games/kitty/acc/bowtie.glb' },
  { id:'crown', name:'Crown', bonus:50, weight:1, model:'/games/kitty/acc/crown.glb' },
] as const

export const PARCEL_COST = { base:500, mult:2.5 }
export const PARCEL_UPGRADE_COST = { base:1000, mult:2.2, kReduction:0.7 }
```

## 4.3 Formulas

```ts
export function machineCost(base:number, mult:number, owned:number) {
  return Math.floor(base * mult**owned)
}
export function productionTime(base:number, speedUpgrades:number, globalMult:number) {
  return base / (1 + speedUpgrades*0.2) / globalMult
}
export function pollutionEfficiency(kEff:number, pollution:number) {
  return Math.exp(-kEff * pollution**2)
}
export function kEff(kBase:number, parcelLevel:number, reduction=0.7) {
  return kBase * reduction**parcelLevel
}
export function colorMult(level:number) { return 1 + level**1.85 * 0.45 }
export function traitMult(tier:number) { return 1.65**tier }
export function raceMult(tier:number) { return 1.75**tier }
export function kittyValue(base=10, c:number, t:number, r:number, acc:number, syn:number, eff:number) {
  return base * c * t * r * acc * syn * eff
}
export function treats(total:number) { return Math.floor((total/1e6)**0.5) }
export function superTreats(total:number, evo:number) { return Math.floor(Math.log10(total/1e9+1)*(evo+1)*0.5) }
export function incredible(total:number) { return Math.floor((total**0.28)/150) }
export function factoryCredits(best:number, tier:number) { return Math.floor(Math.log10(best/1000+1)*tier) }
export function maxPlausibleValue(counts:Record<string,number>) {
  // iterate MACHINES, sum baseValue * count * upgrades, apply max prestige mults
  let max = 0
  for (const m of MACHINES) {
    const c = counts[m.id] ?? 0
    max += m.baseValue * c * 5 // assume max upgrades + prestige
  }
  return max * 100 // generous
}
```

## 4.4 Save Schema

```ts
export const SAVE_VERSION = 2

export type KittySave = {
  v: number
  money: number
  totalKitties: number
  bestValue: number
  gameTime: number
  lastSeenAt: number
  currencies: {
    treats: number
    superTreats: number
    incredible: number
    factoryCredits: number
    locationPoints: number
    yarn: number
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
    level: number
    pollution: number
    machines: Array<{ id:string, lvl:number, x:number, y:number, rot:0|90|180|270 }>
    belts: Array<{ x:number, y:number, dir:'n'|'s'|'e'|'w' }>
  }>
  upgrades: Record<string, number>
  accessories: string[]
  achievements: string[]
  stats: {
    moneyPerSec: number
    kittiesPerSec: number
    efficiency: number
  }
}

export function createNewSave(): KittySave {
  return {
    v: SAVE_VERSION,
    money: 100,
    totalKitties: 0,
    bestValue: 0,
    gameTime: 0,
    lastSeenAt: Date.now(),
    currencies: { treats:0, superTreats:0, incredible:0, factoryCredits:0, locationPoints:0, yarn:0 },
    prestige: { rebirth:0, evolution:0, kitception:0, factoryReset:0, moveOut:0 },
    parcels: [{ id:'p0', x:0, y:0, level:0, pollution:0, machines:[{id:'mom',lvl:0,x:0,y:0,rot:0}], belts:[] }],
    upgrades: {},
    accessories: [],
    achievements: [],
    stats: { moneyPerSec:0, kittiesPerSec:0, efficiency:1 },
  }
}

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
  return JSON.stringify(save) // for MVP, keep <16KiB for 100 machines ~3KB
}
export function compactDecode(str:string): KittySave {
  return migrate(JSON.parse(str))
}
export function offlineProgress(save:KittySave, now=Date.now()) {
  const offlineMs = Math.min(now - save.lastSeenAt, 2*60*60*1000)
  if (offlineMs <= 0) return {moneyGain:0, kittiesGain:0}
  const eff = save.stats.efficiency
  return {
    moneyGain: save.stats.moneyPerSec * offlineMs/1000 * eff,
    kittiesGain: save.stats.kittiesPerSec * offlineMs/1000 * eff,
  }
}
```

Size check: 100 machines ×30B=3KB, parcels 500B, currencies 200B, total <5KB <16KiB.

## 4.5 Prestige Requirements

```ts
export const PRESTIGE = {
  rebirth: { requireMoney:1e6, formula: treats },
  evolution: { requireTreats:100, requireTotalKitties:1e9, formula: superTreats },
  kitception: { requireSuperTreats:50, formula: incredible },
  factoryReset: { requireIncredible:20, formula: factoryCredits },
  moveOut: { requireCredits:10, formula: (best:number)=>Math.floor(best/1e6) },
}
```

## 4.6 Achievements

```ts
export const ACHIEVEMENTS = [
  { id:'first-kitty', name:'First Kitty', desc:'Produce 1 kitty', cond:{type:'totalKitties', target:1}, reward:{yarn:10} },
  { id:'hundred-kitties', name:'Hundred', desc:'100 kitties', cond:{type:'totalKitties', target:100}, reward:{yarn:50} },
  { id:'best-1000', name:'Valuable', desc:'Best value 1000', cond:{type:'bestValue', target:1000}, reward:{yarn:100} },
] as const
```

