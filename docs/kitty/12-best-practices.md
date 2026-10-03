# Kitty Factory — Best Practices (Compatibility, Aesthetic, Shaders)

## Compatibility (Free, Works Everywhere)

- **Three.js 0.160.0 MIT:** Import via `import * as THREE from 'three'` + `OrbitControls` from `three/addons/controls/OrbitControls.js`, `GLTFLoader` from `three/addons/loaders/GLTFLoader.js`. Use importmap in Astro or dynamic import. Client-only, code-split per route, not in Worker.
- **WebGL2 probe:** Reuse `game-runtime.ts` webgl2 fact, handle `webglcontextlost`/`webglcontextrestored` like FluidSandbox.
- **DPR:** `Math.min(2, window.devicePixelRatio)` max 2, like Stack fitCanvas(). ResizeObserver on canvas.
- **Pointer lock:** Require user gesture (click canvas), fallback to orbit if not available. Esc exits.
- **Touch:** OrbitControls handles one finger rotate, two finger zoom/pan. Long press 500ms to place, double tap inspect. No external joystick lib needed.
- **Keyboard:** WASD for FP, Q/E rotate placement, Esc exit, Tab focus toolbar — semantic buttons per GAMES-OPERATIONS.md.
- **Reduced motion:** `matchMedia('(prefers-reduced-motion: reduce)')` → disable damping, bob, emissive pulse, belt scroll speed 0.
- **GameShell lifecycle:** pause stops RAF and controls, resume restarts, destroy disposes renderer, controls, listeners, audio. Prevents leaks.
- **Save:** local IndexedDB every 10s (free), cloud every 2min throttled + manual debounced 5s + prestige, 16KiB max, 25 slots, CAS 409 handling via existing UI.

## Aesthetic — Low-Poly 3D Best Quality

- **Flat shading:** `flatShading: true` on all materials for faceted low-poly look.
- **3 materials max:** 
  - matFactory: MeshStandardMaterial #E8E8E8 roughness 0.8 metalness 0 flatShading
  - matPastel: #FFB5C2 roughness 0.9
  - matAccent: #7DD3C0 roughness 0.7
  No textures, vertexColors false for MVP, pastel palette #FFB5C2 pink, #7DD3C0 mint, #E8E8E8 light gray, #2A2A35 dark ground.
- **No PBR heavy:** roughness 0.7-0.9, metalness 0, no env maps, no post-processing.
- **Fog:** `FogExp2` #0A0A12 density 0.02 + pollution*0.0005 for depth, cheap.
- **Lighting:** Ambient 0.7, Directional 0.8 castShadow 1024 at (10,20,10), Hemisphere 0.3 — single shadow map, toggle off for potato mode.
- **Procedural placeholders:** Box, Cylinder, Sphere with 6-12 faces, <800 tris per machine, looks intentional low-poly, no GLB needed for MVP. Later replace with Kenney GLB (same materials).
- **Kitties:** Capsule 0.3 radius 0.5 height 4 segments + 2 spheres ears, instanced, color tint via InstancedBufferAttribute or material color lerp, bob sin(time*5)*0.05.

## Basic Shaders — Simple, Compatible, Aesthetic

- **Belt shader (UV scroll stripes):**
```glsl
// vertex
varying vec2 vUv;
void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }
// fragment
uniform float time;
varying vec2 vUv;
void main(){
  float scroll = fract(vUv.x + time*0.5);
  float stripe = step(0.5, fract(scroll*4.0));
  vec3 color = vec3(0.3 + stripe*0.2);
  gl_FragColor = vec4(color,1.0);
}
```
Time uniform updated each frame, no texture.

- **Synergy emissive pulse:**
```ts
if (synergyActive) {
  mat.emissive.lerp(new THREE.Color(0x7DD3C0), Math.sin(time*3)*0.2+0.2);
}
```

- **Pollution ground lerp:**
```glsl
uniform float pollution; // 0..1
varying vec2 vUv;
void main(){
  vec3 low = vec3(0.16,0.16,0.21); // #2A2A35
  vec3 high = vec3(0.35,0.23,0.16); // #5A3A2A
  vec3 color = mix(low, high, pollution);
  gl_FragColor = vec4(color,1.0);
}
```

- **No post-processing:** No Bloom, SSAO, etc. — keeps compatibility and performance.

## Performance

- InstancedMesh per machine type, count 100, instanceMatrix update
- Frustum culling default, LOD far parcels Box low-poly
- Shadows 1024 toggle off for potato mode
- RAF only when visible
- Minimap 2D canvas not 3D
- DPR max 2

## Update Ease

- All content in kitty-content.ts, adding machine = 1 entry + 1 GLB, no logic change
- Save migration via v bump + migrate()
- No D1 migration

## Best Results

- Follow 4-5 prompt plan in 11-optimized-4-5-prompt-plan.md
- Verify after each per 08-checklist.md
- Use procedural placeholders first, Kenney GLB later
- Keep 3 materials max, flatShading, basic shaders, FogExp2
- Compatibility first, aesthetic second, performance third

