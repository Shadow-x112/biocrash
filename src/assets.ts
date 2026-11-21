// Props built in Blender (art/blender/bc_props.py), loaded once and handed out by mesh name.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type PropMeshes = Record<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>;

/** Glow strength for organic props (bright vertex colours glow): dim by day, strong at night. */
export const propGlow = { value: 0.6 };

/** Organic props carry their colour in the vertex colours; the brightest of them (bulbs, sprout heads, fibre tips,
 *  the hazard stripe) glow. */
export function addColourGlow(mat: THREE.Material) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPropGlow = propGlow;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uPropGlow;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
          { float m = max(max(vColor.r, vColor.g), vColor.b);
            totalEmissiveRadiance += vColor.rgb * smoothstep(0.7, 1.0, m) * uPropGlow; }
        #endif`);
  };
  mat.customProgramCacheKey = () => 'prop-glow';
  mat.needsUpdate = true;
}

/** Baked emission maps (creatures): scale the emissive glow with the night (propGlow) by k. */
export function addMapGlow(mat: THREE.MeshStandardMaterial, k: number) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPropGlow = propGlow;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uPropGlow;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= uPropGlow * ${k.toFixed(2)};`);
  };
  mat.customProgramCacheKey = () => 'map-glow';
  mat.needsUpdate = true;
}

/**
 * Grounding: darkens and muddies the bottom of a prop where it meets the soil (fake contact occlusion that works
 * with or without screen-space AO). Height is measured in world space above the prop's ground point, which is the
 * instance origin minus lift x instance scale (props are placed lift x scale above the ground). Chains with any
 * onBeforeCompile already on the material.
 */
export function addGrounding(mat: THREE.Material, lift: number, height: number, strength = 0.62) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vGroundH;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        { vec4 gp = vec4(transformed, 1.0); vec4 go = vec4(0.0, 0.0, 0.0, 1.0); float gs = 1.0;
          #ifdef USE_INSTANCING
            gp = instanceMatrix * gp; go = instanceMatrix * go; gs = length(instanceMatrix[0].xyz);
          #endif
          gs *= length(modelMatrix[0].xyz);
          vGroundH = (modelMatrix * gp).y - (modelMatrix * go).y + ${lift.toFixed(3)} * gs; }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGroundH;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        { float gk = smoothstep(0.0, ${height.toFixed(3)}, vGroundH);
          diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.40, 0.36, 0.32) * ${(1 - strength).toFixed(3)} + vec3(0.018, 0.014, 0.011) * ${strength.toFixed(3)}, diffuseColor.rgb, gk); }`);
  };
  mat.customProgramCacheKey = () => prevKey() + `|ground${lift}:${height}`;
  mat.needsUpdate = true;
}

/** Shared world-space detail: a tiling rock normal/roughness map (normal XY in RG, roughness in B). */
let detailTex: THREE.Texture | null = null;
function detailTexture() {
  if (!detailTex) {
    detailTex = new THREE.TextureLoader().load('textures/dark_rock_02_nrm.webp');
    detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping;
    detailTex.colorSpace = THREE.NoColorSpace;
    detailTex.anisotropy = 8;
  }
  return detailTex;
}

export interface DetailOpts {
  /** Detail map tiles per metre. */
  scale: number;
  /** Detail normal strength (0..1). */
  normal: number;
  /** Moss / spore crust on upward faces (0..1). */
  moss?: number;
  /** Chance-weighted wet sheen (0..1). */
  wet?: number;
  /** Large-scale albedo variation (0..1). */
  macro?: number;
  /** Roughness range taken from the detail map. */
  rough?: number;
}

/**
 * The shared prop detail layer (chains with other onBeforeCompile patches):
 *  - triplanar world-space detail normal, whiteout-blended (Ben Golus) and added on top of any baked normal map,
 *  - detail roughness breakup,
 *  - low-frequency macro albedo variation plus a per-instance tint from a hash of the instance origin,
 *  - an alien spore/moss crust on upward faces and occasional wet, darker, glossier instances.
 */
export function addDetail(mat: THREE.Material, o: DetailOpts) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey.bind(mat);
  const tex = detailTexture(), f = (v: number) => v.toFixed(3);
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    sh.uniforms.tDetail = { value: tex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDtPos; varying vec3 vDtNrm; varying float vDtSeed;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        { vec4 dp = vec4(transformed, 1.0); vec3 dn = objectNormal; vec4 dorg = vec4(0.0, 0.0, 0.0, 1.0);
          #ifdef USE_INSTANCING
            dp = instanceMatrix * dp; dn = mat3(instanceMatrix) * dn; dorg = instanceMatrix * dorg;
          #endif
          vDtPos = (modelMatrix * dp).xyz; vDtNrm = normalize(mat3(modelMatrix) * dn);
          vec3 wo = (modelMatrix * dorg).xyz; vDtSeed = fract(sin(dot(wo.xz, vec2(12.9898, 78.233)) + wo.y * 3.17) * 43758.5453); }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tDetail; varying vec3 vDtPos; varying vec3 vDtNrm; varying float vDtSeed;
        float dtHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float dtNoise(vec3 p) { vec3 i = floor(p), u = fract(p); u = u * u * (3.0 - 2.0 * u);
          return mix(mix(mix(dtHash(i), dtHash(i + vec3(1, 0, 0)), u.x), mix(dtHash(i + vec3(0, 1, 0)), dtHash(i + vec3(1, 1, 0)), u.x), u.y),
                     mix(mix(dtHash(i + vec3(0, 0, 1)), dtHash(i + vec3(1, 0, 1)), u.x), mix(dtHash(i + vec3(0, 1, 1)), dtHash(i + vec3(1, 1, 1)), u.x), u.y), u.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 dtN = normalize(vDtNrm);
        vec3 dtW = pow(abs(dtN), vec3(4.0)); dtW /= dtW.x + dtW.y + dtW.z;
        vec3 dtP = vDtPos * ${f(o.scale)};
        vec4 dtX = texture2D(tDetail, dtP.zy), dtY = texture2D(tDetail, dtP.xz), dtZ = texture2D(tDetail, dtP.xy);
        float dtRough = dtX.b * dtW.x + dtY.b * dtW.y + dtZ.b * dtW.z;
        float dtMacro = dtNoise(vDtPos * 0.35) * 0.6 + dtNoise(vDtPos * 1.7) * 0.4;
        diffuseColor.rgb *= mix(1.0, 0.72 + dtMacro * 0.5, ${f(o.macro ?? 0.6)}) * (0.88 + vDtSeed * 0.24);
        float dtUp = smoothstep(0.3, 0.8, dtN.y) * smoothstep(0.3, 0.6, dtNoise(vDtPos * 2.3) * 0.7 + dtRough * 0.3 + vDtSeed * 0.25);
        float dtMoss = dtUp * ${f(o.moss ?? 0)};
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.055, 0.045) * (0.7 + dtMacro * 0.6), dtMoss);
        float dtWet = step(1.0 - ${f(o.wet ?? 0)}, fract(vDtSeed * 7.31)) * (1.0 - dtMoss);
        diffuseColor.rgb *= 1.0 - dtWet * 0.3;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor * mix(1.0, 0.6 + dtRough * 0.8, ${f(o.rough ?? 0.6)}), 0.04, 1.0);
        roughnessFactor = mix(roughnessFactor, 0.95, dtMoss);
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.6, dtWet);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { // Whiteout-blended triplanar detail normal, as a world-space offset added to the shading normal.
          vec3 tx = vec3(dtX.rg * 2.0 - 1.0, 0.0), ty = vec3(dtY.rg * 2.0 - 1.0, 0.0), tz = vec3(dtZ.rg * 2.0 - 1.0, 0.0);
          tx.z = sqrt(max(0.0, 1.0 - dot(tx.xy, tx.xy))); ty.z = sqrt(max(0.0, 1.0 - dot(ty.xy, ty.xy))); tz.z = sqrt(max(0.0, 1.0 - dot(tz.xy, tz.xy)));
          tx = vec3(tx.xy + dtN.zy, abs(tx.z) * dtN.x); ty = vec3(ty.xy + dtN.xz, abs(ty.z) * dtN.y); tz = vec3(tz.xy + dtN.xy, abs(tz.z) * dtN.z);
          vec3 dw = normalize(tx.zyx * dtW.x + ty.xzy * dtW.y + tz.xyz * dtW.z);
          float k = ${f(o.normal)} * (1.0 - dtMoss * 0.6);
          normal = normalize(normal + (mat3(viewMatrix) * (dw - dtN)) * k);
        }`);
  };
  mat.customProgramCacheKey = () => prevKey() + `|detail${o.scale}:${o.normal}:${o.moss ?? 0}:${o.wet ?? 0}`;
  mat.needsUpdate = true;
}

/**
 * Per-instance glow pulse: emission swells and fades on each instance's own seeded phase (chains with other
 * patches; applied after all emission is summed).
 */
export function addPulse(mat: THREE.Material, time: { value: number }, speed = 1.2, depth = 0.45) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    sh.uniforms.uPulseT = time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vPulseSeed;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        { vec3 po = vec3(0.0);
          #ifdef USE_INSTANCING
            po = instanceMatrix[3].xyz;
          #endif
          po = (modelMatrix * vec4(po, 1.0)).xyz; vPulseSeed = fract(sin(dot(po.xz, vec2(41.31, 17.77))) * 9341.7); }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPulseSeed; uniform float uPulseT;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        totalEmissiveRadiance *= 1.0 - ${depth.toFixed(2)} * (0.5 + 0.5 * sin(uPulseT * ${speed.toFixed(2)} * (0.7 + vPulseSeed * 0.6) + vPulseSeed * 6.283));`);
  };
  mat.customProgramCacheKey = () => prevKey() + `|pulse${speed}:${depth}`;
  mat.needsUpdate = true;
}

/** Soft dark contact patch drawn on the ground under props (a radial alpha gradient). */
let splatTex: THREE.Texture | null = null;
export function splatMaterial() {
  if (!splatTex) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d')!, grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    grd.addColorStop(0, 'rgba(255,255,255,0.7)'); grd.addColorStop(0.45, 'rgba(255,255,255,0.4)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    splatTex = new THREE.CanvasTexture(c);
  }
  return new THREE.MeshBasicMaterial({ color: 0x050403, alphaMap: splatTex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
}

let loading: Promise<PropMeshes> | null = null;
export function loadProps(): Promise<PropMeshes> {
  loading ??= new Promise((resolve) => {
    new GLTFLoader().load('models/props.json', (gltf) => {
      const out: PropMeshes = {};
      const seen = new Set<THREE.Material>();
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = m.material as THREE.MeshStandardMaterial;
        if (!seen.has(mat)) {
          seen.add(mat);
          if (mat.vertexColors) addColourGlow(mat);
          if (mat.map) mat.map.anisotropy = 8;
        }
        out[m.name] = { geometry: m.geometry, material: mat };
      });
      resolve(out);
    }, undefined, () => resolve({})); // missing: keep the old shapes
  });
  return loading;
}

export interface CreatureModels {
  rigs: Record<'tuko' | 'oomi', THREE.Object3D>;
  clips: THREE.AnimationClip[];
  figure: THREE.BufferGeometry | null;
}
let creatures: Promise<CreatureModels | null> | null = null;
/** Rigged, animated creatures (art/blender/bc_creatures.py) and the horror figure. */
export function loadCreatures(): Promise<CreatureModels | null> {
  creatures ??= new Promise((resolve) => {
    new GLTFLoader().load('models/creatures.json', (gltf) => {
      const tuko = gltf.scene.getObjectByName('Tuko'), oomi = gltf.scene.getObjectByName('Oomi');
      const fig = gltf.scene.getObjectByName('Figure') as THREE.Mesh | undefined;
      if (!tuko || !oomi) { resolve(null); return; }
      for (const r of [tuko, oomi]) { r.parent?.remove(r); r.position.set(0, 0, 0); }
      resolve({ rigs: { tuko, oomi }, clips: gltf.animations, figure: fig ? fig.geometry : null });
    }, undefined, () => resolve(null));
  });
  return creatures;
}
