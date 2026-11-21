// Atmosphere: one post-processing pass (bloom on glowing things, unease-driven vignette and grain, colour fringing only
// during glitches), ground mist on the terrain, and wind / night "breathing" on the mushrooms. All cheap; all optional.
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, VignetteEffect, NoiseEffect, ChromaticAberrationEffect,
  ToneMappingEffect, ToneMappingMode, BlendFunction, Effect, SMAAEffect, SMAAPreset,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

/** Tone curve. AgX was tried (truer glow hues) but lifts the blacks and greys the world out; ACES keeps it dark. */
export const TONE_MODE = ToneMappingMode.ACES_FILMIC;

/** Colour grade, before tone mapping: saturation, then a gain (tint of the highlights) and a lift (tint of the shadows). */
class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', /* glsl */ `
      uniform vec3 gain; uniform vec3 lift; uniform float sat;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = inputColor.rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, sat);
        c = c * gain + lift * (1.0 - clamp(c, 0.0, 1.0));
        outputColor = vec4(c, inputColor.a);
      }`, {
      uniforms: new Map<string, THREE.Uniform>([
        ['gain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))], ['lift', new THREE.Uniform(new THREE.Vector3())], ['sat', new THREE.Uniform(1)],
      ]),
    });
  }
}

// Grades by time of day: day slightly warm and lively, dusk golden, night cool with teal in the shadows.
const GRADES = {
  day: { gain: new THREE.Vector3(0.94, 1.02, 0.97), lift: new THREE.Vector3(0.0, 0.004, 0.002), sat: 0.82 },
  dusk: { gain: new THREE.Vector3(1.06, 0.94, 0.86), lift: new THREE.Vector3(0.004, 0.0, 0.0), sat: 0.85 },
  night: { gain: new THREE.Vector3(0.82, 0.97, 1.04), lift: new THREE.Vector3(0.0, 0.003, 0.004), sat: 0.75 },
};

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Post {
  readonly composer: EffectComposer;
  private bloom: BloomEffect;
  private vignette: VignetteEffect;
  private noise: NoiseEffect;
  private ca: ChromaticAberrationEffect;
  private grade = new GradeEffect();
  /** Screen-space ambient occlusion (contact darkening under and between props). */
  readonly ao: N8AOPostPass;
  enabled = true;
  /** Reduce flashing: no colour split or grain spikes. */
  reduceFlash = false;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, hands?: { scene: THREE.Scene; camera: THREE.Camera }) {
    // Half-float buffers: 8-bit ones band badly in near-black night scenes.
    // No hardware MSAA: it breaks the AO's depth; SMAA (last pass) antialiases instead.
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(scene, camera));
    // AO on the world only (before the held tool is drawn). Radius in metres; a dark, slightly teal-brown tint
    // instead of pure black so it reads as soil and shadow, not a dirty screen.
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.ao = new N8AOPostPass(scene, camera, size.x, size.y);
    Object.assign(this.ao.configuration, {
      aoRadius: 0.9, distanceFalloff: 0.6, intensity: 3.2, color: new THREE.Color(0x05080a),
      halfRes: false, gammaCorrection: false, transparencyAware: false,
    });
    this.ao.setQualityMode('Medium');
    this.composer.addPass(this.ao);
    // The held tool: drawn after the world into the same image, with the depth cleared first so it never clips into
    // terrain, and still under the same bloom, grade and tone mapping.
    if (hands) {
      const hp = new RenderPass(hands.scene, hands.camera);
      hp.clearPass.setClearFlags(false, true, false);
      hp.ignoreBackground = true;
      this.composer.addPass(hp);
    }
    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.85, luminanceSmoothing: 0.25, intensity: 1.1, radius: 0.7 });
    this.vignette = new VignetteEffect({ offset: 0.32, darkness: 0.25 });
    // Screen blend: overlay grain does nothing on near-black pixels, which hid it exactly at night.
    this.noise = new NoiseEffect({ blendFunction: BlendFunction.SCREEN, premultiply: true });
    this.noise.blendMode.opacity.value = 0.03;
    // Chromatic aberration (the pass's one convolution effect) sits at zero offset unless the core glitches. Everything
    // is merged into one pass: a disabled last pass would leave nothing drawn to the screen.
    this.ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.2 });
    // Colour split first, so it splits the bloomed image (after bloom it gave green halos), then grade before tone mapping.
    const pass = new EffectPass(camera, this.ca, this.bloom, this.grade, this.vignette, this.noise, new ToneMappingEffect({ mode: TONE_MODE }));
    pass.dithering = true; // the final 8-bit image otherwise bands in near-black night gradients
    this.composer.addPass(pass);
    this.composer.addPass(new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    // The composer tone-maps itself; drawing straight to the screen, the renderer does it.
    this.renderer.toneMapping = on ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  }

  setSize(w: number, h: number) { this.composer.setSize(w, h); }

  /** MSAA samples (0 on Low quality). */
  /** Quality: 0 = no AO; 1 = half-resolution AO; 2+ = full-resolution AO. */
  setQuality(q: number) {
    this.ao.enabled = q >= 1;
    this.ao.configuration.halfRes = q < 2;
    this.ao.setQualityMode(q >= 2 ? 'Medium' : 'Low');
  }

  /** Per frame: unease darkens the edges and thickens the grain; glitches and static flashes split the colours. */
  update(unease: number, glitch: number, staticFlash: number, daylight = 1, night = 0) {
    // Blend day -> dusk -> night by the sky, and drain colour as unease rises.
    const u = this.grade.uniforms, duskW = Math.max(0, 1 - daylight - night) * 1.5, total = daylight + night + duskW || 1;
    const mix = (k: 'gain' | 'lift') => (u.get(k)!.value as THREE.Vector3).set(0, 0, 0)
      .addScaledVector(GRADES.day[k], daylight / total).addScaledVector(GRADES.dusk[k], duskW / total).addScaledVector(GRADES.night[k], night / total);
    mix('gain'); mix('lift');
    u.get('sat')!.value = (GRADES.day.sat * daylight + GRADES.dusk.sat * duskW + GRADES.night.sat * night) / total - smooth(0.3, 1, unease) * 0.2;
    this.vignette.darkness = 0.25 + smooth(0.2, 1, unease) * 0.6;
    this.vignette.offset = 0.32 - smooth(0.3, 1, unease) * 0.12;
    this.noise.blendMode.opacity.value = 0.03 + smooth(0.3, 1, unease) * 0.08 + (staticFlash > 0 && !this.reduceFlash ? 0.25 : 0);
    if ((glitch > 0 || staticFlash > 0) && !this.reduceFlash) this.ca.offset.set((Math.random() - 0.5) * 0.012, (Math.random() - 0.5) * 0.006);
    else this.ca.offset.set(0, 0);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, dt: number, hands?: { scene: THREE.Scene; camera: THREE.Camera }) {
    if (this.enabled) { this.composer.render(dt); return; }
    this.renderer.render(scene, camera);
    if (hands) { // world, then the held tool over it with depth cleared
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(hands.scene, hands.camera);
      this.renderer.autoClear = true;
    }
  }
}

/** Shared uniforms for the mist and sway shaders, updated once per frame. */
export const fxUniforms = {
  uFxTime: { value: 0 },
  uMist: { value: 0 },        // 0..1 ground-mist strength (night, unease)
  uMistTop: { value: 0 },     // world height the mist sits below (just under your eyes)
  uBreath: { value: 0 },      // 0..1 how much the mushrooms "breathe" (night, unease)
  uRim: { value: new THREE.Color(0, 0, 0) }, // edge light on flora and creatures: warm by day, teal at night
};

const RIM_PARS = 'uniform vec3 uRim;';
/** Edge (rim) light: surfaces seen edge-on get a little emissive light, so silhouettes separate from the fog. */
const RIM_FRAG = `#include <emissivemap_fragment>
  { float rimF = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 3.0);
    totalEmissiveRadiance += uRim * rimF; }`;

/** Rim light only (creatures). */
export function addRim(mat: THREE.Material) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, fxUniforms);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + RIM_PARS).replace('#include <emissivemap_fragment>', RIM_FRAG);
  };
  mat.customProgramCacheKey = () => 'rim';
  mat.needsUpdate = true;
}

/** The ground: three photographed CC0 surfaces (alien soil, ash, dark rock; Poly Haven) projected from three sides
 *  (triplanar, so cliffs and dug walls don't stretch), blended by slope and patch with their height maps, plus normal
 *  and roughness detail. The mesher's vertex colour carries the weights: r = flatness, g = depth, b = patch.
 *  Also the drifting ground mist that pools below eye height. */
export function addTerrainSurface(mat: THREE.Material, aniso: number) {
  const load = (n: string, srgb: boolean) => {
    const t = new THREE.TextureLoader().load(`textures/${n}.webp`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const tex = {
    tSoilC: { value: load('mud_forest_col', true) }, tSoilN: { value: load('mud_forest_nrm', false) },
    tAshC: { value: load('burned_ground_01_col', true) }, tAshN: { value: load('burned_ground_01_nrm', false) },
    tRockC: { value: load('dark_rock_02_col', true) }, tRockN: { value: load('dark_rock_02_nrm', false) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, fxUniforms, tex);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMistWorld; varying vec3 vWN;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvMistWorld = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vMistWorld; varying vec3 vWN;
        uniform float uFxTime; uniform float uMist; uniform float uMistTop;
        uniform sampler2D tSoilC, tSoilN, tAshC, tAshN, tRockC, tRockN;
        float fxHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float fxNoise(vec3 x) {
          vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(fxHash(i), fxHash(i + vec3(1,0,0)), f.x), mix(fxHash(i + vec3(0,1,0)), fxHash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(fxHash(i + vec3(0,0,1)), fxHash(i + vec3(1,0,1)), f.x), mix(fxHash(i + vec3(0,1,1)), fxHash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        vec3 triW(vec3 n) { vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z); }
        vec4 triC(sampler2D t, vec3 p, vec3 w) {
          return texture2D(t, p.zy) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z;
        }
        // Triplanar normal (whiteout blend) -> world space; .w = roughness.
        vec4 triN(sampler2D t, vec3 p, vec3 w, vec3 n) {
          vec3 a = texture2D(t, p.zy).rgb, b = texture2D(t, p.xz).rgb, c = texture2D(t, p.xy).rgb;
          vec2 ax = a.rg * 2.0 - 1.0, bx = b.rg * 2.0 - 1.0, cx = c.rg * 2.0 - 1.0;
          vec3 nx = vec3(ax + n.zy, abs(sqrt(max(0.0, 1.0 - dot(ax, ax)))) * n.x);
          vec3 ny = vec3(bx + n.xz, abs(sqrt(max(0.0, 1.0 - dot(bx, bx)))) * n.y);
          vec3 nz = vec3(cx + n.xy, abs(sqrt(max(0.0, 1.0 - dot(cx, cx)))) * n.z);
          vec3 wn = normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
          return vec4(wn, a.b * w.x + b.b * w.y + c.b * w.z);
        }
        vec3 gN; float gRough;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 n = normalize(vWN), w = triW(n), p = vMistWorld;
          float gFlat = vColor.r, gDeep = vColor.g, gPatch = vColor.b;
          // Macro variation so the tiling doesn't show from a distance.
          float macro = fxNoise(p * 0.07) * 0.6 + fxNoise(p * 0.21) * 0.4;
          vec4 cS = triC(tSoilC, p * 0.26, w), cA = triC(tAshC, p * 0.3, w), cR = triC(tRockC, p * 0.19, w);
          // Slope and patch weights, sharpened by each surface's height map (ash fills the soil's hollows, rock pokes through).
          float wR = 1.0 - gFlat, wA = gFlat * smoothstep(0.45, 0.75, gPatch + (macro - 0.5) * 0.5), wS = max(0.0, gFlat - wA);
          vec3 hw = vec3(wS * (cS.a + 0.4), wA * (cA.a + 0.4), wR * (cR.a + 0.4));
          float mx = max(hw.x, max(hw.y, hw.z));
          hw = max(hw - mx + 0.25, 0.0); hw /= (hw.x + hw.y + hw.z + 1e-4);
          vec3 alb = cS.rgb * vec3(0.52, 0.58, 0.6) * hw.x + cA.rgb * vec3(0.62, 0.56, 0.62) * hw.y + cR.rgb * vec3(0.55, 0.55, 0.62) * hw.z;
          alb *= mix(0.8, 1.1, macro);
          alb *= 1.0 - gDeep * 0.55;
          diffuseColor.rgb = alb;
          vec4 nS = triN(tSoilN, p * 0.26, w, n), nA = triN(tAshN, p * 0.3, w, n), nR = triN(tRockN, p * 0.19, w, n);
          vec4 nn = nS * hw.x + nA * hw.y + nR * hw.z;
          gN = normalize(nn.xyz); gRough = clamp(nn.w * 1.05, 0.35, 1.0);
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);')
      .replace('#include <fog_fragment>', `#include <fog_fragment>
      #ifdef USE_FOG
        float mistH = 1.0 - smoothstep(uMistTop - 7.0, uMistTop, vMistWorld.y);
        float drift = sin(vMistWorld.x * 0.09 + uFxTime * 0.13) * sin(vMistWorld.z * 0.11 - uFxTime * 0.09) * 0.5 + 0.5;
        float mistD = smoothstep(4.0, 38.0, vFogDepth);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(uMist * mistH * mistD * (0.5 + 0.5 * drift), 0.0, 0.85));
      #endif`);
  };
  mat.customProgramCacheKey = () => 'ground3';
  mat.needsUpdate = true;
}

/** Wind sway in world units, phased by position so it rolls across the forest like gusts; at night it slows into an
 *  out-of-phase "breathing". `bend` scales the motion by the vertex height (sprouts bend from the base; caps move whole). */
export function addSway(mat: THREE.Material, amp: number, bend = false, rim = true) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, fxUniforms);
    if (rim) sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + RIM_PARS).replace('#include <emissivemap_fragment>', RIM_FRAG);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uFxTime; uniform float uBreath;')
      .replace('#include <project_vertex>', `#include <project_vertex>
      {
        vec3 base = vec3(0.0);
        #ifdef USE_INSTANCING
          base = instanceMatrix[3].xyz;
        #endif
        base = (modelMatrix * vec4(base, 1.0)).xyz;
        float ph = base.x * 0.15 + base.z * 0.11;
        float speed = mix(1.0, 0.45, uBreath);
        vec3 sway = vec3(sin(uFxTime * 0.7 * speed + ph), 0.0, cos(uFxTime * 0.53 * speed + ph * 1.3)) * ${amp.toFixed(3)} * (1.0 + uBreath);
        sway.y = sin(uFxTime * 0.4 + ph * 2.0) * uBreath * ${(amp * 0.6).toFixed(3)};
        ${bend ? 'sway *= clamp(transformed.y * 2.5, 0.0, 1.0);' : ''}
        mvPosition.xyz += (viewMatrix * vec4(sway, 0.0)).xyz;
        gl_Position = projectionMatrix * mvPosition;
      }`);
  };
  // three.js caches programs by the onBeforeCompile source text, which is the same for every call: key on the settings,
  // or two materials with different sway (spots vs sprouts) share whichever program compiled first.
  mat.customProgramCacheKey = () => `sway:${amp}:${bend}:${rim}`;
  mat.needsUpdate = true;
}

/**
 * A dim reflection environment tinted by the current sky (sky colour above, ground colour below), rebuilt every
 * few seconds. Without one, metal and wet surfaces render flat black in the dark.
 */
export class SkyEnv {
  private scene = new THREE.Scene();
  private top = new THREE.Uniform(new THREE.Color());
  private bottom = new THREE.Uniform(new THREE.Color());
  private pmrem: THREE.PMREMGenerator;
  private rt: THREE.WebGLRenderTarget | null = null;
  private timer = 0;

  constructor(renderer: THREE.WebGLRenderer, private target: THREE.Scene, private intensity = 0.4) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, uniforms: { top: this.top, bottom: this.bottom },
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vDir;
        void main() { float y = normalize(vDir).y; gl_FragColor = vec4(mix(bottom, top, smoothstep(-0.25, 0.35, y)), 1.0); }`,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), mat));
  }

  update(dt: number, hemi: THREE.HemisphereLight) {
    if ((this.timer -= dt) > 0 && this.rt) return;
    this.timer = 3;
    this.top.value.copy(hemi.color).multiplyScalar(hemi.intensity);
    this.bottom.value.copy(hemi.groundColor).multiplyScalar(hemi.intensity * 0.6);
    const old = this.rt;
    this.rt = this.pmrem.fromScene(this.scene, 0, 0.1, 100, { size: 64 });
    this.target.environment = this.rt.texture;
    this.target.environmentIntensity = this.intensity;
    old?.dispose();
  }
}
