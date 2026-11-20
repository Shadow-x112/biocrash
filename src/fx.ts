// Atmosphere: one post-processing pass (bloom on glowing things, unease-driven vignette and grain, colour fringing only
// during glitches), ground mist on the terrain, and wind / night "breathing" on the mushrooms. All cheap; all optional.
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, VignetteEffect, NoiseEffect, ChromaticAberrationEffect,
  ToneMappingEffect, ToneMappingMode, BlendFunction, Effect,
} from 'postprocessing';

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
  day: { gain: new THREE.Vector3(1.03, 1.0, 0.96), lift: new THREE.Vector3(0, 0, 0), sat: 1.06 },
  dusk: { gain: new THREE.Vector3(1.1, 0.96, 0.84), lift: new THREE.Vector3(0.004, 0.0, 0.0), sat: 1.0 },
  night: { gain: new THREE.Vector3(0.86, 0.96, 1.1), lift: new THREE.Vector3(0.0, 0.004, 0.007), sat: 0.82 },
};

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Post {
  readonly composer: EffectComposer;
  private bloom: BloomEffect;
  private vignette: VignetteEffect;
  private noise: NoiseEffect;
  private ca: ChromaticAberrationEffect;
  private grade = new GradeEffect();
  enabled = true;
  /** Reduce flashing: no colour split or grain spikes. */
  reduceFlash = false;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, hands?: { scene: THREE.Scene; camera: THREE.Camera }) {
    // Half-float buffers: 8-bit ones band badly in near-black night scenes.
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: Math.min(4, renderer.capabilities.maxSamples) });
    this.composer.addPass(new RenderPass(scene, camera));
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
    const pass = new EffectPass(camera, this.ca, this.bloom, this.grade, this.vignette, this.noise, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    pass.dithering = true; // the final 8-bit image otherwise bands in near-black night gradients
    this.composer.addPass(pass);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    // The composer tone-maps itself; drawing straight to the screen, the renderer does it.
    this.renderer.toneMapping = on ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  }

  setSize(w: number, h: number) { this.composer.setSize(w, h); }

  /** MSAA samples (0 on Low quality). */
  setSamples(n: number) { this.composer.multisampling = Math.min(n, this.renderer.capabilities.maxSamples); }

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

/** Ground mist on the terrain: pools below eye height and in hollows, drifts slowly, fades in past a few metres. */
export function addTerrainMist(mat: THREE.Material) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, fxUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMistWorld;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvMistWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vMistWorld;
        uniform float uFxTime; uniform float uMist; uniform float uMistTop;
        float fxHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float fxNoise(vec3 x) { // value noise
          vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(fxHash(i), fxHash(i + vec3(1,0,0)), f.x), mix(fxHash(i + vec3(0,1,0)), fxHash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(fxHash(i + vec3(0,0,1)), fxHash(i + vec3(1,0,1)), f.x), mix(fxHash(i + vec3(0,1,1)), fxHash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }`)
      // Surface detail without textures: two octaves of world-space noise (~0.5 m and ~4 m) vary the colour by about
      // +-10%, hollows are a little darker and damper, high ground a little paler (spore dust).
      .replace('#include <color_fragment>', `#include <color_fragment>
        float fxN = (fxNoise(vMistWorld * 2.0) - 0.5) * 0.12 + (fxNoise(vMistWorld * 0.25) - 0.5) * 0.18;
        diffuseColor.rgb *= 1.0 + fxN;
        diffuseColor.rgb *= mix(0.88, 1.0, smoothstep(2.0, 12.0, vMistWorld.y));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.84, 0.8), smoothstep(34.0, 52.0, vMistWorld.y) * 0.25);`)
      .replace('#include <fog_fragment>', `#include <fog_fragment>
      #ifdef USE_FOG
        float mistH = 1.0 - smoothstep(uMistTop - 7.0, uMistTop, vMistWorld.y); // (reversed edges are undefined in GLSL)
        float drift = sin(vMistWorld.x * 0.09 + uFxTime * 0.13) * sin(vMistWorld.z * 0.11 - uFxTime * 0.09) * 0.5 + 0.5;
        float mistD = smoothstep(4.0, 38.0, vFogDepth);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(uMist * mistH * mistD * (0.5 + 0.5 * drift), 0.0, 0.85));
      #endif`);
  };
  mat.customProgramCacheKey = () => 'mist2';
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
