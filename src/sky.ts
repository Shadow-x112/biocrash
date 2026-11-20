// Day/night cycle: a gradient sky dome with sun, two moons and stars, plus the lights and fog it drives.
import * as THREE from 'three';

/** Real seconds for one full day. */
export const DAY_LENGTH = 20 * 60;

interface Palette { zenith: THREE.Color; horizon: THREE.Color; hemiSky: THREE.Color; hemiGround: THREE.Color; hemi: number; }
const pal = (z: number, h: number, hs: number, hg: number, hemi: number): Palette => ({
  zenith: new THREE.Color(z), horizon: new THREE.Color(h), hemiSky: new THREE.Color(hs), hemiGround: new THREE.Color(hg), hemi,
});
const NIGHT = pal(0x020409, 0x070b14, 0x1c2840, 0x050508, 0.1); // dark nights: firelight matters
const DUSK = pal(0x27305a, 0xd9825a, 0xb49aa8, 0x3a2c22, 0.75);
const DAY = pal(0x4f86c2, 0xb8d2e5, 0xcfe3f2, 0x2a241e, 0.7);

const vert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const frag = /* glsl */ `
  uniform vec3 zenith, horizon, sunDir, moonDir, moon2Dir;
  uniform float night;
  varying vec3 vDir;
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -0.2, 1.0);
    vec3 col = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
    col = mix(col, horizon * 0.6, smoothstep(0.0, -0.2, d.y)); // below the horizon
    // Sun: disc plus warm glow.
    float s = max(dot(d, sunDir), 0.0);
    col += vec3(1.0, 0.82, 0.55) * (pow(s, 600.0) * 6.0 + pow(s, 12.0) * 0.25) * (1.0 - night * 0.9);
    // Moons: a large pale one and a small rust-coloured one.
    float m1 = smoothstep(0.9994, 0.9996, dot(d, moonDir));
    float m2 = smoothstep(0.99985, 0.9999, dot(d, moon2Dir));
    col = mix(col, vec3(0.86, 0.9, 0.95), m1 * (0.25 + night * 0.75));
    col = mix(col, vec3(0.8, 0.45, 0.32), m2 * (0.25 + night * 0.75));
    // Stars, only at night and away from the horizon.
    vec3 cell = floor(d * 260.0);
    float st = step(0.9965, hash(cell)) * hash(cell + 7.0);
    col += vec3(st) * night * smoothstep(0.02, 0.25, d.y) * (1.0 - m1);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export class Sky {
  /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  time = 0.3;
  speed = 1;
  readonly sun = new THREE.DirectionalLight(0xfff1dc, 3);
  private snap = new THREE.Vector3();
  /** Sun and moon are never both meaningful, so one directional light plays whichever is up (one light fewer on every
   *  pixel, and no shader recompiles: the light count never changes). */
  private moonCol = new THREE.Color(0x9fb4e0);
  readonly hemi = new THREE.HemisphereLight();
  readonly sunDir = new THREE.Vector3();
  /** 0 by day, 1 at full night. */
  night = 0;
  /** 0 at night, 1 in full daylight: drives air temperature. */
  daylight = 1;
  private dome: THREE.Mesh;
  private uniforms = {
    zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3() }, moonDir: { value: new THREE.Vector3() }, moon2Dir: { value: new THREE.Vector3() },
    night: { value: 0 },
  };
  private tmp = new THREE.Color();

  constructor(private scene: THREE.Scene) {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: vert, fragmentShader: frag,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(140, 32, 16), mat);
    this.dome.renderOrder = -1;
    this.dome.frustumCulled = false;
    scene.add(this.dome, this.sun, this.sun.target, this.hemi);
  }

  /** Keep the dome inside the camera's far plane (which follows the fog). */
  setRadius(r: number) { this.dome.scale.setScalar(r / 140); }

  /** Hours and minutes for the HUD. */
  clock() {
    const mins = Math.floor(this.time * 24 * 60);
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }

  update(dt: number, camera: THREE.Camera) {
    this.time = (this.time + (dt * this.speed) / DAY_LENGTH) % 1;
    const a = (this.time - 0.25) * Math.PI * 2; // sun angle: 0 at sunrise
    // Tilted orbit so the sun never sits straight overhead (gives longer shadows and a nicer light).
    this.sunDir.set(Math.cos(a), Math.sin(a) * 0.85, Math.sin(a) * 0.35 + 0.25).normalize();
    const elev = this.sunDir.y;

    // Blend palettes: night below -0.15, dusk around the horizon, day above 0.25.
    const dayW = THREE.MathUtils.smoothstep(elev, 0.02, 0.3);
    const nightW = THREE.MathUtils.smoothstep(-elev, 0.02, 0.18);
    this.night = nightW;
    this.daylight = THREE.MathUtils.smoothstep(elev, -0.12, 0.4);
    const mixPal = (key: 'zenith' | 'horizon' | 'hemiSky' | 'hemiGround', out: THREE.Color) =>
      out.copy(DUSK[key]).lerp(DAY[key], dayW).lerp(NIGHT[key], nightW);

    mixPal('zenith', this.uniforms.zenith.value);
    mixPal('horizon', this.uniforms.horizon.value);
    mixPal('hemiSky', this.hemi.color);
    mixPal('hemiGround', this.hemi.groundColor);
    this.hemi.intensity = THREE.MathUtils.lerp(THREE.MathUtils.lerp(DUSK.hemi, DAY.hemi, dayW), NIGHT.hemi, nightW);

    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) fog.color.copy(this.uniforms.horizon.value);

    // Sun light warms and fades near the horizon; the big moon takes over at night.
    const sunUp = THREE.MathUtils.smoothstep(elev, -0.08, 0.1);
    const sunI = 3.2 * sunUp;
    this.sun.color.copy(this.tmp.setRGB(1, 0.62, 0.38)).lerp(new THREE.Color(1, 0.95, 0.86), dayW);
    const moonDir = this.uniforms.moonDir.value.copy(this.sunDir).multiplyScalar(-1).add(new THREE.Vector3(0.3, 0.25, -0.2)).normalize();
    this.uniforms.moon2Dir.value.copy(moonDir).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.9).add(new THREE.Vector3(0, -0.15, 0)).normalize();
    const moonI = 0.32 * nightW * THREE.MathUtils.smoothstep(moonDir.y, -0.05, 0.15);
    const moonUp = moonI > sunI;
    this.sun.intensity = moonUp ? moonI : sunI;
    if (moonUp) this.sun.color.copy(this.moonCol);

    this.uniforms.sunDir.value.copy(this.sunDir);
    this.uniforms.night.value = nightW;

    // Lights and dome follow the camera.
    const c = camera.position;
    this.dome.position.copy(c);
    // Shadow centre snapped to a 0.25 m grid so the shadow map doesn't crawl as the player walks.
    const s = this.snap.set(Math.round(c.x * 4) / 4, Math.round(c.y * 4) / 4, Math.round(c.z * 4) / 4);
    this.sun.position.copy(s).addScaledVector(moonUp ? moonDir : this.sunDir, 50);
    this.sun.target.position.copy(s);
  }
}
