// Props built in Blender (art/blender/bc_props.py), loaded once and handed out by mesh name.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type PropMeshes = Record<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>;

/** Glow strength for organic props (bright vertex colours glow): dim by day, strong at night. */
export const propGlow = { value: 0.6 };

/** Organic props carry their colour in the vertex colours; the brightest of them (bulbs, sprout heads, fibre tips,
 *  the hazard stripe) glow. */
function addColourGlow(mat: THREE.Material) {
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
