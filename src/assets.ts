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

/** Soft dark contact patch drawn on the ground under props (a radial alpha gradient). */
let splatTex: THREE.Texture | null = null;
export function splatMaterial() {
  if (!splatTex) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d')!, grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    grd.addColorStop(0, 'rgba(255,255,255,0.85)'); grd.addColorStop(0.45, 'rgba(255,255,255,0.5)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
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
