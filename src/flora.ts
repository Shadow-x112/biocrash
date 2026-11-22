// Fungal forest flora: giant mushrooms you can harvest for stalkwood, glowing sprouts, and drifting
// spores at night. Placement comes from the worker's decoration pass (unedited terrain, seeded per chunk).
import * as THREE from 'three';
import { addSway, fxUniforms } from './fx';
import type RAPIER from '@dimforge/rapier3d';
import { STRIDE, type DecoData } from './terrain/deco';
import { InstancePool } from './pool';
import { addFade, addPulse, addWind, prepGlow } from './assets';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const STALK_HARVESTS = 4;   // uses per mushroom
export const STALK_YIELD = 2;      // stalkwood per use

interface Shroom {
  id: string; source: number; kind: 'giant' | 'small';
  base: THREE.Vector3; radius: number; height: number;
  body: RAPIER.RigidBody | null;
  slot: number;
  alive: boolean;
  /** Placement, kept so harvesting can rebuild the instances (shorter stalk, toppled at the end). */
  q: THREE.Quaternion; capR: number; color: number; spin: number;
  /** Glow patch on the ground under the cap (-1: none, e.g. once felled), and the ground normal there. */
  card: number; n: THREE.Vector3;
  /** Current pose and per-instance sizes, so it can move between the near (detailed) and far pools. */
  pose: THREE.Matrix4; dims: [number, number, number];
  /** Slot in the detailed near pool (-1: drawn with the light far mesh). */
  near: number;
}
interface ChunkFlora {
  shrooms: Shroom[];
  sprouts: { slot: number; source: number; bulb: boolean; card: number }[];
}

const SPROUT = new THREE.MeshStandardMaterial({ color: 0x24403a, emissive: 0x7affd6, emissiveIntensity: 0.3, flatShading: true });
addSway(SPROUT, 0.1, true);
// Vein colours, one per fungus: teal, cold blue, blood magenta, acid green.
const CAP_COLORS = [0x3dffc8, 0x5aa0ff, 0xff3d78, 0x9dff3a].map((c) => new THREE.Color(c));

// --- One fungus = one object ---------------------------------------------------------------------------
// Alien bell fungi: a twisted, ridged trunk with a flared foot; a drooping bell cap (outer skin plus a dark inner
// lining), and luminous tendrils hanging from the rim. All merged into one mesh, so nothing can drift apart. Per
// vertex: aPart (0 trunk, 1 crown), aTint (1 = cap skin, carries the glowing veins), aGlow (<0: dim self-light of
// the lining), aTend (0 at a tendril's root .. 1 at its tip; sways most at the tip). Per fungus (iDims): trunk radius,
// trunk length, cap radius. The shader stretches only the trunk and seats the crown on top.
const BODY_COL = new THREE.Color(0x15121a), LINING_COL = new THREE.Color(0x2a1430), TRUNK_COL = new THREE.Color(0x1d1a1e);
const BELL_STEPS = 14, SEG = 32, PHI_END = Math.PI * 0.62;
const bell = (s: number, a: number, inner: boolean) => {
  // Profile from the crown (s = 0) to the lobed rim (s = 1).
  const phi = s * PHI_END, lobe = 1 + 0.08 * Math.sin(a * 7) * s * s;
  const k = inner ? 0.95 : 1;
  return new THREE.Vector3(Math.cos(a) * Math.sin(phi) * lobe * k, (Math.cos(phi) * 0.75 - 0.12) * (inner ? 0.97 : 1) - (inner ? 0.03 : 0), Math.sin(a) * Math.sin(phi) * lobe * k);
};
const bodyGeo = (() => {
  const pos: number[] = [], col: number[] = [], part: number[] = [], tint: number[] = [], glow: number[] = [], tend: number[] = [];
  const push = (v: THREE.Vector3, c: THREE.Color, p: number, t: number, g: number, td: number) => {
    pos.push(v.x, v.y, v.z); col.push(c.r, c.g, c.b); part.push(p); tint.push(t); glow.push(g); tend.push(td);
  };
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, ...rest: [THREE.Color, number, number, number, number[]]) => {
    const [cl, p, t, g, td] = rest;
    push(a, cl, p, t, g, td[0]); push(b, cl, p, t, g, td[1]); push(c, cl, p, t, g, td[2]);
    push(a, cl, p, t, g, td[0]); push(c, cl, p, t, g, td[2]); push(d, cl, p, t, g, td[3]);
  };
  const z4 = [0, 0, 0, 0];
  // Trunk: 1 unit tall, unit radius (stretched per fungus), twisted ridges, flared foot.
  const TR = 16, TS = 18;
  const trunk = (j: number, i: number) => {
    const t = j / TS, a = i / TR * Math.PI * 2 + t * 2.2;
    const r = (1 + 0.95 * Math.exp(-((t / 0.09) ** 2)) - 0.3 * t + 0.06 * Math.sin(t * 17)) * (1 + 0.1 * Math.sin(a * 5 + t * 6));
    return new THREE.Vector3(Math.cos(a) * r * 0.75, t, Math.sin(a) * r * 0.75);
  };
  for (let j = 0; j < TS; j++) for (let i = 0; i < TR; i++)
    quad(trunk(j, i), trunk(j + 1, i), trunk(j + 1, i + 1), trunk(j, i + 1), TRUNK_COL, 0, 0, 0, z4);
  // Bell: outer skin (veined) and inner lining (wound the other way so it faces down/in).
  for (let j = 0; j < BELL_STEPS; j++) for (let i = 0; i < SEG; i++) {
    const a0 = i / SEG * Math.PI * 2, a1 = (i + 1) / SEG * Math.PI * 2, s0 = j / BELL_STEPS, s1 = (j + 1) / BELL_STEPS;
    quad(bell(s0, a0, false), bell(s0, a1, false), bell(s1, a1, false), bell(s1, a0, false), BODY_COL, 1, 1, 0, z4);
    quad(bell(s0, a0, true), bell(s1, a0, true), bell(s1, a1, true), bell(s0, a1, true), LINING_COL, 1, 0, -0.35, z4);
  }
  // Rim band joining skin and lining.
  for (let i = 0; i < SEG; i++) {
    const a0 = i / SEG * Math.PI * 2, a1 = (i + 1) / SEG * Math.PI * 2;
    quad(bell(1, a0, false), bell(1, a1, false), bell(1, a1, true), bell(1, a0, true), BODY_COL, 1, 1, 0, z4);
  }
  // Tendrils: thin four-sided tubes hanging from just inside the rim, tapering, curling a little.
  const TN = 16, TSEG = 7;
  for (let n = 0; n < TN; n++) {
    const a = n / TN * Math.PI * 2 + Math.sin(n * 12.9) * 0.15;
    const root = bell(0.93, a, true);
    const len = 0.7 + ((Math.sin(n * 78.2) * 43758.5) % 1 + 1) % 1 * 0.9;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= TSEG; k++) {
      const t = k / TSEG;
      pts.push(root.clone().add(new THREE.Vector3(Math.sin(t * 3 + n) * 0.05 * t, -len * t, Math.cos(t * 2.5 + n) * 0.05 * t)));
    }
    for (let k = 0; k < TSEG; k++) {
      const r0 = 0.011 * (1 - (k / TSEG) * 0.75), r1 = 0.011 * (1 - ((k + 1) / TSEG) * 0.75);
      for (let side = 0; side < 4; side++) {
        const b0 = side / 4 * Math.PI * 2, b1 = (side + 1) / 4 * Math.PI * 2;
        const off = (r: number, b: number) => new THREE.Vector3(Math.cos(b) * r, 0, Math.sin(b) * r);
        const t0 = k / TSEG, t1 = (k + 1) / TSEG;
        quad(pts[k].clone().add(off(r0, b0)), pts[k + 1].clone().add(off(r1, b0)), pts[k + 1].clone().add(off(r1, b1)), pts[k].clone().add(off(r0, b1)),
          BODY_COL, 1, 2, 0, [t0, t1, t1, t0]);
      }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  out.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 1));
  out.setAttribute('aGlow', new THREE.Float32BufferAttribute(glow, 1));
  out.setAttribute('aTend', new THREE.Float32BufferAttribute(tend, 1));
  const merged = mergeVertices(out, 1e-4); // shared vertices -> smooth shading (seams stay where attributes differ)
  merged.computeVertexNormals();
  return merged;
})();
// Unit bell outline for its physics shape (convex hull, scaled per fungus): the cap is solid, you can stand on it.
const CAP_HULL = (() => {
  const out: number[] = [];
  for (let j = 0; j <= BELL_STEPS; j += 2) for (let i = 0; i < SEG; i += 2) { const v = bell(j / BELL_STEPS, i / SEG * Math.PI * 2, false); out.push(v.x, v.y, v.z); }
  return out;
})();
const BODY_VERT = `
  float SINK = 0.4 + iDims.x * 1.5;
  vec3 transformed = aPart < 0.5
    ? vec3(position.x * iDims.x, position.y * (iDims.y + SINK) - SINK, position.z * iDims.x)
    : position * iDims.z + vec3(0.0, iDims.y, 0.0);`;
const SWAY = `
  {
    vec3 base = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
    float ph = base.x * 0.15 + base.z * 0.11, speed = mix(1.0, 0.45, uBreath);
    vec3 sway = vec3(sin(uFxTime * 0.7 * speed + ph), sin(uFxTime * 0.4 + ph * 2.0) * uBreath * 0.6, cos(uFxTime * 0.53 * speed + ph * 1.3)) * 0.07 * (1.0 + uBreath);
    sway *= clamp(transformed.y / max(iDims.y, 0.5), 0.0, 1.0); // rooted: the trunk bends, the crown moves most
    // Tendrils trail and swing on their own, most at the tips.
    sway += vec3(sin(uFxTime * 1.3 + ph * 3.0 + position.x * 9.0), 0.0, cos(uFxTime * 1.1 + ph * 2.0 + position.z * 9.0)) * aTend * aTend * 0.12 * iDims.z;
    mvPosition.xyz += (viewMatrix * vec4(sway, 0.0)).xyz;
    gl_Position = projectionMatrix * mvPosition;
  }`;
const BODY = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.0 });
const glowU = { value: 0.6 };
// Tiling detail (art/blender/bc_flora.py): R blistered skin, G trunk fibres, B blotches. Sampled triplanar in metres,
// so the stretched trunk and every cap size get the same texel density. Grey until it loads.
const detailU = { value: (() => { const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); t.needsUpdate = true; return t; })() as THREE.Texture };
new THREE.TextureLoader().load('textures/fungus_detail.webp', (t) => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8; detailU.value = t;
});
BODY.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, fxUniforms, { uGlow: glowU, uDetail: detailU });
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aPart; attribute float aTint; attribute float aGlow; attribute float aTend; attribute vec3 iDims;\nvarying float vGlow; varying float vTint; varying float vTend; varying vec3 vLocal; varying vec3 vVein; varying float vSeed; varying float vPart; varying vec3 vDP; varying vec3 vDN; varying mat3 vNM; uniform float uFxTime; uniform float uBreath;')
    .replace('#include <begin_vertex>', BODY_VERT + '\n  vGlow = aGlow; vTint = aTint; vTend = aTend; vLocal = position; vVein = instanceColor.rgb; vPart = aPart; vDP = transformed; vDN = objectNormal; vNM = normalMatrix * mat3(instanceMatrix);\n  vSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);')
    .replace('#include <color_vertex>', 'vColor = vec4(1.0); vColor.rgb = color.rgb;')
    .replace('#include <project_vertex>', '#include <project_vertex>' + SWAY);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
      varying float vGlow; varying float vTint; varying float vTend; varying vec3 vLocal; varying vec3 vVein; varying float vSeed; uniform float uGlow; uniform vec3 uRim; uniform float uFxTime;
      varying float vPart; varying vec3 vDP; varying vec3 vDN; varying mat3 vNM; uniform sampler2D uDetail;
      // Height for this part: trunk fibres (G) or cap blisters (R, softer on the lining and gills).
      float bcHt(vec2 uv, float skin) { vec4 t = texture2D(uDetail, uv); return vPart < 0.5 ? t.g : t.r * mix(0.55, 1.0, skin); }
      // Height slope in texture space by central differences (smooth, unlike screen-space derivatives).
      vec2 bcGrad(vec2 uv, float skin) {
        const float E = 1.5 / 1024.0;
        return vec2(bcHt(uv + vec2(E, 0.0), skin) - bcHt(uv - vec2(E, 0.0), skin), bcHt(uv + vec2(0.0, E), skin) - bcHt(uv - vec2(0.0, E), skin));
      }
      vec3 h3(vec3 p) { p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6))); return fract(sin(p) * 43758.5453); }
      // Distance to the nearest cell edge (F2 - F1): thin glowing veins along the cell borders.
      float veinEdge(vec3 p) {
        vec3 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
        for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
          vec3 g = vec3(float(x), float(y), float(z)); vec3 r = g + h3(i + g) - f; float d = dot(r, r);
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
        }
        return sqrt(d2) - sqrt(d1);
      }`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      vec3 bcW = pow(abs(normalize(vDN)), vec3(4.0)); bcW /= bcW.x + bcW.y + bcW.z;
      vec3 bcP = vDP * (vPart < 0.5 ? vec3(0.45, 0.16, 0.45) : vec3(0.32));
      vec4 bcD = texture2D(uDetail, bcP.zy) * bcW.x + texture2D(uDetail, bcP.xz) * bcW.y + texture2D(uDetail, bcP.xy) * bcW.z;
      float bcSkin = step(0.5, vTint) * step(vTint, 1.5);
      float bcH = vPart < 0.5 ? bcD.g : mix(bcD.r * 0.6, bcD.r, bcSkin);
      diffuseColor.rgb *= mix(0.6, 1.3, bcD.b) * mix(0.7, 1.05, bcH);`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      // Matte fibrous trunk and gills; the cap skin is mostly dull with slick, wet-looking patches.
      roughnessFactor = vPart < 0.5 ? mix(0.72, 0.92, bcD.b) : mix(0.88, mix(0.32, 0.78, smoothstep(0.25, 0.6, bcD.b)) - (1.0 - bcH) * 0.08, bcSkin);`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        // Triplanar bump, whiteout-blended in object space, then into view space with the instance's normal matrix.
        vec3 n0 = normalize(vDN); float k = vPart < 0.5 ? 3.0 : 2.0;
        vec3 tx = vec3(-bcGrad(bcP.zy, bcSkin) * k, 1.0), ty = vec3(-bcGrad(bcP.xz, bcSkin) * k, 1.0), tz = vec3(-bcGrad(bcP.xy, bcSkin) * k, 1.0);
        tx = vec3(tx.xy + n0.zy, abs(tx.z) * n0.x); ty = vec3(ty.xy + n0.xz, abs(ty.z) * n0.y); tz = vec3(tz.xy + n0.xy, abs(tz.z) * n0.z);
        vec3 np = normalize(tx.zyx * bcW.x + ty.xzy * bcW.y + tz.xyz * bcW.z);
        normal = normalize(vNM * np) * faceDirection;
      }`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      // Each fungus breathes on its own slow cycle (seeded by where it stands), so a grove never pulses in step.
      float breathe = 0.72 + 0.28 * sin(uFxTime * (0.18 + vSeed * 0.14) + vSeed * 40.0);
      float rimF = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 3.0);
      if (vTint > 1.5) {
        float flick = 0.8 + 0.2 * sin(uFxTime * 2.3 + vSeed * 17.0 + vLocal.x * 11.0);
        totalEmissiveRadiance += vVein * uGlow * (0.15 + vTend * 0.7) * breathe * flick; // tendrils, brightest at the tips
      } else if (vTint > 0.5) {
        vec3 q = vLocal * 5.5 + sin(vLocal.zxy * 7.0) * 0.22;
        float e = veinEdge(q);
        float vein = 1.0 - smoothstep(0.012, 0.05, e);
        // Light travelling outward from each vein through the flesh: a wide soft halo (fake subsurface scattering).
        float halo = 1.0 - smoothstep(0.03, 0.32, e);
        float pulse = 0.55 + 0.45 * sin(uFxTime * (0.6 + vSeed * 0.7) + vSeed * 6.28 + vLocal.y * 6.0 + vLocal.x * 3.0);
        totalEmissiveRadiance += vVein * uGlow * breathe * (vein * (0.6 + pulse * 0.8) + halo * halo * 0.16 * (0.7 + pulse * 0.3));
        totalEmissiveRadiance += vVein * rimF * 0.22 * uGlow * breathe; // thin edges glow through, in the cap's colour
      } else if (vGlow < 0.0) {
        totalEmissiveRadiance += vVein * 0.08 * uGlow * -vGlow * breathe; // the lining glows faintly from the veins above
      }
      totalEmissiveRadiance += uRim * rimF;`);
};
BODY.side = THREE.DoubleSide;
BODY.customProgramCacheKey = () => 'fungus-body';
// Shadows are drawn with a depth material: it needs the same trunk stretch, or the shadow would be a unit fungus.
const BODY_DEPTH = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
BODY_DEPTH.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aPart; attribute vec3 iDims;')
    .replace('#include <begin_vertex>', BODY_VERT);
};
BODY_DEPTH.customProgramCacheKey = () => 'fungus-depth';
const sproutGeo = (() => {
  const parts = [new THREE.ConeGeometry(0.05, 0.35, 5).translate(0, 0.17, 0), new THREE.SphereGeometry(0.06, 6, 4).translate(0, 0.37, 0)];
  const pos: number[] = [], nrm: number[] = [];
  for (const p of parts) {
    const g = p.toNonIndexed();
    pos.push(...(g.getAttribute('position').array as Float32Array)); nrm.push(...(g.getAttribute('normal').array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return out;
})();

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
/** Real lights lent to the nearest glowing fungi (a fixed pool: no shader recompiles). */
const GLOW_LIGHTS = 4;
const BULB_GLOW = new THREE.Color(0x4fe8c8).multiplyScalar(0.55);
const CARD = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!, grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,0.8)'); grd.addColorStop(0.25, 'rgba(255,255,255,0.4)'); grd.addColorStop(0.6, 'rgba(255,255,255,0.1)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, color: 0x000000 });
})();

export class Flora {
  readonly group = new THREE.Group();
  /** How many times each mushroom has been harvested (saved). */
  readonly harvested = new Map<string, number>();
  /** Ground nothing may grow on (the wreck). */
  blocked?: (x: number, z: number) => boolean;
  private chunks = new Map<string, ChunkFlora>();
  private bodies: InstancePool;
  /** The Blender fungus, for the closest fungi only (LOD): far ones keep the light code-built mesh. */
  private nearPool: InstancePool | null = null;
  private lodTimer = 0;
  private sprouts: InstancePool;
  private bulbs: InstancePool;
  private cards: InstancePool;
  private lights: THREE.PointLight[] = [];
  private lightTimer = 0;
  private spores: THREE.Points;
  private sporeVel: Float32Array;
  // Scratch objects for look-ups (no per-call allocation).
  private ray = new THREE.Ray();
  private sphere = new THREE.Sphere();
  private hit = new THREE.Vector3();
  private origin = new THREE.Vector3();
  private dir = new THREE.Vector3();

  constructor(private rapier: typeof RAPIER, private physics: RAPIER.World, private avoid: THREE.Vector3) {
    this.bodies = new InstancePool(bodyGeo, BODY, this.group, 1024, true, true, { extra: { name: 'iDims', size: 3 }, depth: BODY_DEPTH });
    this.sprouts = new InstancePool(sproutGeo, SPROUT, this.group, 4096);
    this.bulbs = new InstancePool(sproutGeo, SPROUT, this.group, 1024);
    // Glow cast on the ground: additive patches in each cap's colour (cheap stand-ins for real light), plus a few
    // real shadowless lights handed to the nearest glowing fungi at night.
    const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.cards = new InstancePool(quad, CARD, this.group, 1024, true);
    this.cards.mesh.renderOrder = 1;
    for (let i = 0; i < GLOW_LIGHTS; i++) {
      const l = new THREE.PointLight(0x3dffc8, 0, 11, 1.7);
      this.lights.push(l); this.group.add(l);
    }
    const n = 260;
    const pos = new Float32Array(n * 3);
    this.sporeVel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos.set([(Math.random() - 0.5) * 40, Math.random() * 10, (Math.random() - 0.5) * 40], i * 3);
      this.sporeVel.set([(Math.random() - 0.5) * 0.3, 0.05 + Math.random() * 0.15, (Math.random() - 0.5) * 0.3], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.spores = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x9fffe6, size: 0.09, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.spores.frustumCulled = false;
    this.group.add(this.spores);
  }

  onChunkMesh(key: string, deco: DecoData) {
    const c = this.chunks.get(key);
    if (c) this.applyValidity(c, deco);
    else this.spawn(key, deco);
  }

  onChunkUnload(key: string) {
    const c = this.chunks.get(key);
    if (!c) return;
    for (const s of c.shrooms) this.removeShroom(s);
    for (const sp of c.sprouts) this.releaseSprout(sp);
    this.chunks.delete(key);
  }

  private spawn(key: string, deco: DecoData) {
    const c: ChunkFlora = { shrooms: [], sprouts: [] };
    type Placed = { p: THREE.Vector3; n: THREE.Vector3; h: number; r: number; cap: number; tilt: number; spin: number; color: number; id: string; source: number; kind: 'giant' | 'small' };
    const placed: Placed[] = [];
    for (const kind of ['giant', 'small'] as const) {
      const d = deco[kind];
      const [hMin, hMax] = kind === 'giant' ? [7, 15] : [1.2, 3.5];
      for (let i = 0; i < d.length / STRIDE; i++) {
        const o = i * STRIDE;
        if (!d[o + 8]) continue;
        const p = new THREE.Vector3(d[o], d[o + 1], d[o + 2]);
        if (Math.hypot(p.x - this.avoid.x, p.z - this.avoid.z) < 9) continue; // keep the crash site clear
        if (this.blocked?.(p.x, p.z)) continue; // not through the wreck
        const h = hMin + d[o + 4] * (hMax - hMin);
        const capR = h * (kind === 'giant' ? 0.32 : 0.4);
        if (placed.some((q) => q.p.distanceTo(p) < (q.cap + capR) * 0.8)) continue; // no overlapping caps
        placed.push({ p, n: new THREE.Vector3(d[o + 9], d[o + 3], d[o + 10]).normalize(), h, r: h * (kind === 'giant' ? 0.06 : 0.09), cap: capR, tilt: (d[o + 5] - 0.5) * 0.25,
          spin: d[o + 6] * Math.PI * 2, color: Math.floor(d[o + 7] * CAP_COLORS.length) % CAP_COLORS.length, id: `${key}:${kind}:${i}`, source: i, kind });
      }
    }

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
    for (const o of placed) {
      e.set(o.tilt, o.spin, o.tilt * 0.6);
      q.setFromEuler(e);
      const slot = this.bodies.alloc(m.compose(o.p, q, one), CAP_COLORS[o.color]);
      this.bodies.setExtra(slot, o.r, o.h, o.cap);
      const s: Shroom = { id: o.id, source: o.source, kind: o.kind, base: o.p, radius: o.r, height: o.h, body: null, slot, alive: true,
        q: q.clone(), capR: o.cap, color: o.color, spin: o.spin, card: -1, n: o.n, pose: m.clone(), dims: [o.r, o.h, o.cap], near: -1 };
      c.shrooms.push(s);
      this.shape(s); // physics, and the harvested state if it was already cut
      if (this.usesLeft(s) > 0) s.card = this.cards.alloc(this.cardMatrix(s, m), CAP_COLORS[o.color]);
    }

    // Glowing sprouts.
    const sd = deco.sprout;
    const up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3();
    for (let i = 0; i < sd.length / STRIDE; i++) {
      const o = i * STRIDE;
      if (!sd[o + 8]) continue;
      // One in nine is a cluster of glowing bulbs instead of a single sprout.
      const bulb = i % 9 === 0;
      m.compose(p.set(sd[o], sd[o + 1], sd[o + 2]), q.setFromAxisAngle(up, sd[o + 5] * 6.28), sc.setScalar(bulb ? 1.2 + sd[o + 4] * 1.6 : 0.6 + sd[o + 4] * 0.9));
      const slot = (bulb ? this.bulbs : this.sprouts).alloc(m);
      // Bulb clusters throw a small teal glow on the ground.
      const card = bulb ? this.cards.alloc(m.compose(p.set(sd[o], sd[o + 1] + 0.04, sd[o + 2]), q.identity(), sc.set(1.6 + sd[o + 4], 1, 1.6 + sd[o + 4])), BULB_GLOW) : -1;
      c.sprouts.push({ slot, source: i, bulb, card });
    }
    this.chunks.set(key, c);
  }

  private removeShroom(s: Shroom) {
    if (!s.alive) return;
    s.alive = false;
    this.clearBody(s);
    this.bodies.release(s.slot);
    if (s.near >= 0) { this.nearPool!.release(s.near); s.near = -1; }
    this.dropCard(s);
  }

  private releaseSprout(sp: ChunkFlora['sprouts'][number]) {
    (sp.bulb ? this.bulbs : this.sprouts).release(sp.slot);
    if (sp.card >= 0) this.cards.release(sp.card);
  }

  private dropCard(s: Shroom) { if (s.card >= 0) { this.cards.release(s.card); s.card = -1; } }

  /** The ground glow patch: flat on the slope under the cap, a little wider than the cap. */
  private cardMatrix(s: Shroom, m: THREE.Matrix4) {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), s.n);
    const w = s.capR * 2.7;
    return m.compose(s.base.clone().addScaledVector(s.n, 0.05), q, new THREE.Vector3(w, 1, w));
  }

  /** Swap in the Blender-built fungus (bc_flora.py): same unit layout and per-vertex tags as the code-built one. */
  setFungus(m: { geometry: THREE.BufferGeometry } | undefined) {
    if (!m) return;
    const g = m.geometry;
    for (const [from, to] of [['_apart', 'aPart'], ['_atint', 'aTint'], ['_aglow', 'aGlow'], ['_atend', 'aTend']] as const) {
      const at = g.getAttribute(from) ?? g.getAttribute(from.toUpperCase());
      if (!at) return; // an older export without the tags: keep the code-built fungus
      g.setAttribute(to, at);
    }
    const part = g.getAttribute('aPart'), glow = g.getAttribute('aGlow'), n = part.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) (part.getX(i) < 0.5 ? TRUNK_COL : glow.getX(i) < 0 ? LINING_COL : BODY_COL).toArray(col, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    this.nearPool = new InstancePool(g, BODY, this.group, 128, true, true, { extra: { name: 'iDims', size: 3 }, depth: BODY_DEPTH });
    this.lodTimer = 0;
  }

  /** Use the Blender-built sprout and bulb models once loaded. */
  setLooks(meshes: Record<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>) {
    if (meshes.Sprout) {
      const mat = prepGlow(meshes.Sprout.material.clone()), g = meshes.Sprout.geometry;
      g.computeBoundingBox();
      addWind(mat, fxUniforms.uFxTime, 0.12, Math.max(0.05, g.boundingBox!.max.y));
      addFade(mat, 50, 70);
      this.sprouts.setLook(g, mat);
    }
    if (meshes.Bulbs) {
      const mat = prepGlow(meshes.Bulbs.material.clone(), 1.0);
      addPulse(mat, fxUniforms.uFxTime, 1.1, 0.5);
      const g = meshes.Bulbs.geometry; g.computeBoundingBox();
      addWind(mat, fxUniforms.uFxTime, 0.06, Math.max(0.05, g.boundingBox!.max.y)); // bulbs bob on their stems
      this.bulbs.setLook(meshes.Bulbs.geometry, mat);
    }
  }

  /** Removes mushrooms already grown on ground that's now blocked (the wreck settled after they loaded). */
  clearBlocked() {
    if (!this.blocked) return;
    for (const c of this.chunks.values()) for (const s of c.shrooms) if (s.alive && this.blocked(s.base.x, s.base.z)) this.removeShroom(s);
  }

  /** After digging or filling: mushrooms and sprouts whose ground changed are removed (with their colliders). */
  private applyValidity(c: ChunkFlora, deco: DecoData) {
    for (const s of c.shrooms) if (s.alive && !deco[s.kind][s.source * STRIDE + 8]) this.removeShroom(s);
    c.sprouts = c.sprouts.filter((sp) => {
      if (deco.sprout[sp.source * STRIDE + 8]) return true;
      this.releaseSprout(sp);
      return false;
    });
  }

  /** The mushroom stalk the camera faces within reach (for harvesting stalkwood). */
  lookAt(camera: THREE.Camera, reach: number): Shroom | null {
    camera.getWorldPosition(this.origin);
    camera.getWorldDirection(this.dir);
    this.ray.set(this.origin, this.dir);
    let best: Shroom | null = null, bestT = reach;
    for (const c of this.chunks.values()) for (const s of c.shrooms) {
      if (!s.alive || this.usesLeft(s) <= 0) continue; // toppled stalks lie on the ground: nothing left to cut
      const dx = s.base.x - this.origin.x, dz = s.base.z - this.origin.z;
      if (dx * dx + dz * dz > (reach + 2) * (reach + 2)) continue; // cheap reject
      // Approximate the stalk as a sphere at eye height, clamped to the stalk's length.
      this.sphere.center.set(s.base.x, Math.min(Math.max(this.origin.y, s.base.y + 0.3), s.base.y + s.height * 0.8), s.base.z);
      this.sphere.radius = s.radius + 0.15;
      if (this.ray.intersectSphere(this.sphere, this.hit)) {
        const t = this.hit.distanceTo(this.origin);
        if (t < bestT) { bestT = t; best = s; }
      }
    }
    return best;
  }

  /** Writes a fungus's pose to whichever pool draws it (the far slot is kept but hidden while it's near). */
  private place(s: Shroom) {
    if (s.near >= 0 && this.nearPool) {
      this.nearPool.set(s.near, s.pose); this.nearPool.setExtra(s.near, ...s.dims);
      this.bodies.set(s.slot, HIDDEN);
    } else this.bodies.set(s.slot, s.pose);
    this.bodies.setExtra(s.slot, ...s.dims);
  }

  /** LOD: the closest fungi (giants reach further) are drawn with the detailed mesh; the rest with the light one. */
  private assignLod(viewer: THREE.Vector3) {
    const pool = this.nearPool!, want = new Set<Shroom>(), cand: { s: Shroom; d: number }[] = [];
    for (const c of this.chunks.values()) for (const s of c.shrooms) {
      if (!s.alive) continue;
      const d = s.base.distanceTo(viewer) - s.capR * 4;
      if (d < 45) cand.push({ s, d });
    }
    cand.sort((a, b) => a.d - b.d);
    for (const { s } of cand.slice(0, 120)) want.add(s);
    for (const c of this.chunks.values()) for (const s of c.shrooms) {
      if (s.near >= 0 && !want.has(s)) { pool.release(s.near); s.near = -1; this.place(s); }
    }
    for (const s of want) if (s.near < 0) { s.near = pool.alloc(s.pose, CAP_COLORS[s.color]); this.place(s); }
  }

  /** The nearest standing fungi within 35 m get the real lights (giants count double in reach). */
  private assignLights(viewer: THREE.Vector3) {
    const near: { s: Shroom; d: number }[] = [];
    for (const c of this.chunks.values()) for (const s of c.shrooms) {
      if (!s.alive || s.card < 0) continue;
      const d = s.base.distanceToSquared(viewer) / (s.kind === 'giant' ? 4 : 1);
      if (d < 35 * 35) near.push({ s, d });
    }
    near.sort((a, b) => a.d - b.d);
    this.lights.forEach((l, i) => {
      const x = near[i]?.s;
      l.userData.s = x ?? null;
      if (!x) { l.intensity = 0; return; }
      const h = x.height * (1 - 0.18 * Math.min(STALK_HARVESTS, this.harvested.get(x.id) ?? 0));
      l.position.copy(x.base).y += h * 0.8;           // under the cap, lighting the stalk and ground
      l.distance = Math.max(8, x.capR * 3.2);
      l.color.copy(CAP_COLORS[x.color]);
      l.userData.ph = x.base.x * 0.37 + x.base.z;
    });
  }

  usesLeft(s: Shroom) { return STALK_HARVESTS - (this.harvested.get(s.id) ?? 0); }

  harvest(s: Shroom) {
    if (this.usesLeft(s) <= 0) return 0;
    this.harvested.set(s.id, (this.harvested.get(s.id) ?? 0) + 1);
    this.shape(s);
    return STALK_YIELD;
  }

  /** True once a mushroom has been cut all the way down (it lies toppled). */
  toppled(s: Shroom) { return this.usesLeft(s) <= 0; }

  /** Rebuilds a mushroom's instances for how often it's been cut: each cut takes ~18% off the stalk (the cap sinks
   *  with it); the last one topples it: the stalk lies on the ground, the cap is gone. */
  private clearBody(s: Shroom) {
    if (s.body) { this.physics.removeRigidBody(s.body); s.body = null; }
  }

  /** One solid body per mushroom, posed like its mesh: a trunk cylinder plus the cap's convex hull (you can stand on
   *  it). Every mushroom, small ones included. */
  private solid(s: Shroom, pos: THREE.Vector3, rot: THREE.Quaternion, h: number) {
    this.clearBody(s);
    const R = this.rapier;
    const body = this.physics.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z).setRotation(rot));
    const sink = 0.4 + s.radius * 1.5, len = h + sink;
    this.physics.createCollider(R.ColliderDesc.cylinder(len / 2, s.radius * 0.85).setTranslation(0, len / 2 - sink, 0), body);
    const pts = new Float32Array(CAP_HULL.length);
    for (let i = 0; i < pts.length; i++) pts[i] = CAP_HULL[i] * s.capR;
    const hull = R.ColliderDesc.convexHull(pts);
    if (hull) this.physics.createCollider(hull.setTranslation(0, h, 0), body);
    s.body = body;
  }

  /** Poses a mushroom for how often it's been cut: each cut takes ~18% off the trunk and the cap sinks with it. The
   *  last cut fells it whole, cap and all: it tips over along its spin direction until the cap rim meets the ground,
   *  leaving the trunk propped at an angle. */
  private shape(s: Shroom) {
    const n = Math.min(STALK_HARVESTS, this.harvested.get(s.id) ?? 0);
    const pos = s.base.clone(), one = new THREE.Vector3(1, 1, 1);
    let rot = s.q, h = s.height * (1 - 0.18 * n);
    if (n >= STALK_HARVESTS) {
      this.dropCard(s); // felled: its cap no longer hangs over the ground
      h = s.height * (1 - 0.18 * (STALK_HARVESTS - 1)); // cut at the base: the whole remaining trunk comes down
      const lean = Math.min(Math.PI / 2 - 0.08, Math.max(0.9, Math.PI / 2 - Math.atan2(s.capR - s.radius, h)));
      rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(s.spin), 0, Math.sin(s.spin)), lean);
      pos.y += s.radius * 0.6;
    }
    s.pose.compose(pos, rot, one); s.dims = [s.radius, h, s.capR];
    this.place(s);
    this.solid(s, pos, rot, h);
  }

  update(dt: number, viewer: THREE.Vector3, night: number) {
    const glow = 0.25 + night * 1.9;
    glowU.value = 0.45 + night * 1.6; // the fungi glow by day too (the days are dim); far more at night
    SPROUT.emissiveIntensity = glow * 1.1;
    CARD.color.setScalar(0.015 + night * 0.11);
    if ((this.lightTimer -= dt) <= 0) { this.lightTimer = 0.5; this.assignLights(viewer); }
    if (this.nearPool && (this.lodTimer -= dt) <= 0) { this.lodTimer = 0.3; this.assignLod(viewer); }
    for (const l of this.lights) if (l.userData.s) l.intensity = (0.4 + night * 5.5) * (0.8 + 0.2 * Math.sin(performance.now() * 0.0007 + l.userData.ph));
    const pos = this.spores.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (night > 0.02) {
      const a = pos.array as Float32Array;
      for (let i = 0; i < a.length; i += 3) {
        a[i] += this.sporeVel[i] * dt; a[i + 1] += this.sporeVel[i + 1] * dt; a[i + 2] += this.sporeVel[i + 2] * dt;
        if (a[i + 1] > 10) a[i + 1] = 0;
        if (a[i] > 20) a[i] -= 40; else if (a[i] < -20) a[i] += 40;
        if (a[i + 2] > 20) a[i + 2] -= 40; else if (a[i + 2] < -20) a[i + 2] += 40;
      }
      pos.needsUpdate = true;
    }
    this.spores.position.set(viewer.x, viewer.y - 3, viewer.z);
    (this.spores.material as THREE.PointsMaterial).opacity = night * 0.9;
  }
}
