// Atmosphere: one post-processing pass (bloom on glowing things, unease-driven vignette and grain, colour fringing only
// during glitches), ground mist on the terrain, and wind / night "breathing" on the mushrooms. All cheap; all optional.
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, VignetteEffect, NoiseEffect, ChromaticAberrationEffect,
  ToneMappingEffect, ToneMappingMode, BlendFunction,
} from 'postprocessing';

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Post {
  readonly composer: EffectComposer;
  private bloom: BloomEffect;
  private vignette: VignetteEffect;
  private noise: NoiseEffect;
  private ca: ChromaticAberrationEffect;
  enabled = true;
  /** Reduce flashing: no colour split or grain spikes. */
  reduceFlash = false;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    // Half-float buffers: 8-bit ones band badly in near-black night scenes.
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: Math.min(4, renderer.capabilities.maxSamples) });
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.85, luminanceSmoothing: 0.25, intensity: 1.1, radius: 0.7 });
    this.vignette = new VignetteEffect({ offset: 0.32, darkness: 0.25 });
    this.noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true });
    this.noise.blendMode.opacity.value = 0.05;
    // Chromatic aberration (the pass's one convolution effect) sits at zero offset unless the core glitches. Everything
    // is merged into one pass: a disabled last pass would leave nothing drawn to the screen.
    this.ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.2 });
    const pass = new EffectPass(camera, this.bloom, this.ca, this.vignette, this.noise, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    pass.dithering = true; // the final 8-bit image otherwise bands in near-black night gradients
    this.composer.addPass(pass);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    // The composer tone-maps itself; drawing straight to the screen, the renderer does it.
    this.renderer.toneMapping = on ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  }

  setSize(w: number, h: number) { this.composer.setSize(w, h); }

  /** Per frame: unease darkens the edges and thickens the grain; glitches and static flashes split the colours. */
  update(unease: number, glitch: number, staticFlash: number) {
    this.vignette.darkness = 0.25 + smooth(0.2, 1, unease) * 0.6;
    this.vignette.offset = 0.32 - smooth(0.3, 1, unease) * 0.12;
    this.noise.blendMode.opacity.value = 0.05 + smooth(0.3, 1, unease) * 0.12 + (staticFlash > 0 && !this.reduceFlash ? 0.35 : 0);
    if ((glitch > 0 || staticFlash > 0) && !this.reduceFlash) this.ca.offset.set((Math.random() - 0.5) * 0.012, (Math.random() - 0.5) * 0.006);
    else this.ca.offset.set(0, 0);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, dt: number) {
    if (this.enabled) this.composer.render(dt);
    else this.renderer.render(scene, camera);
  }
}

/** Shared uniforms for the mist and sway shaders, updated once per frame. */
export const fxUniforms = {
  uFxTime: { value: 0 },
  uMist: { value: 0 },        // 0..1 ground-mist strength (night, unease)
  uMistTop: { value: 0 },     // world height the mist sits below (just under your eyes)
  uBreath: { value: 0 },      // 0..1 how much the mushrooms "breathe" (night, unease)
};

/** Ground mist on the terrain: pools below eye height and in hollows, drifts slowly, fades in past a few metres. */
export function addTerrainMist(mat: THREE.Material) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, fxUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMistWorld;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvMistWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMistWorld;\nuniform float uFxTime; uniform float uMist; uniform float uMistTop;')
      .replace('#include <fog_fragment>', `#include <fog_fragment>
      #ifdef USE_FOG
        float mistH = 1.0 - smoothstep(uMistTop - 7.0, uMistTop, vMistWorld.y); // (reversed edges are undefined in GLSL)
        float drift = sin(vMistWorld.x * 0.09 + uFxTime * 0.13) * sin(vMistWorld.z * 0.11 - uFxTime * 0.09) * 0.5 + 0.5;
        float mistD = smoothstep(4.0, 38.0, vFogDepth);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(uMist * mistH * mistD * (0.5 + 0.5 * drift), 0.0, 0.85));
      #endif`);
  };
  mat.customProgramCacheKey = () => 'mist';
  mat.needsUpdate = true;
}

/** Wind sway in world units, phased by position so it rolls across the forest like gusts; at night it slows into an
 *  out-of-phase "breathing". `bend` scales the motion by the vertex height (sprouts bend from the base; caps move whole). */
export function addSway(mat: THREE.Material, amp: number, bend = false) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, fxUniforms);
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
  mat.customProgramCacheKey = () => `sway:${amp}:${bend}`;
  mat.needsUpdate = true;
}
