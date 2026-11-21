// Day/night cycle: a gradient sky dome with sun, two moons and stars, plus the lights and fog it drives.
import * as THREE from 'three';

/** Real seconds for one full day. */
export const DAY_LENGTH = 20 * 60;

interface Palette { zenith: THREE.Color; horizon: THREE.Color; hemiSky: THREE.Color; hemiGround: THREE.Color; hemi: number; }
const pal = (z: number, h: number, hs: number, hg: number, hemi: number): Palette => ({
  zenith: new THREE.Color(z), horizon: new THREE.Color(h), hemiSky: new THREE.Color(hs), hemiGround: new THREE.Color(hg), hemi,
});
// Dark and alien all day: a dim, sickly green-teal haze by day, a rust band at dusk, near-black nights where the
// fungi and fires are most of the light.
const NIGHT = pal(0x010203, 0x05100c, 0x0e1c24, 0x030304, 0.08);
const DUSK = pal(0x10162a, 0x5c3428, 0x55606a, 0x1a1210, 0.38);
const DAY = pal(0x14221f, 0x4c6a56, 0x7f9a8c, 0x1a1416, 0.55);

const vert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const frag = /* glsl */ `
  uniform vec3 zenith, horizon, sunDir, moonDir, moon2Dir, planetDir;
  uniform float night;
  varying vec3 vDir;
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -0.2, 1.0);
    vec3 col = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
    col = mix(col, horizon * 0.6, smoothstep(0.0, -0.2, d.y)); // below the horizon
    // A sickly glow hugging the horizon.
    col += vec3(0.05, 0.12, 0.08) * exp(-abs(d.y) * 14.0) * (1.0 - night * 0.6);
    // Sun: a small, hard, pale-amber star with a thin halo.
    float s = max(dot(d, sunDir), 0.0);
    col += vec3(1.0, 0.86, 0.62) * (pow(s, 1800.0) * 9.0 + pow(s, 40.0) * 0.12) * (1.0 - night * 0.95);
    // The gas giant: a huge banded disc, lit on the sun's side, always up there.
    float pd = dot(d, planetDir);
    if (pd > 0.982) {
      vec3 up = normalize(cross(planetDir, vec3(0.3, 0.0, 1.0)));
      vec3 rt = cross(up, planetDir);
      vec2 q = vec2(dot(d, rt), dot(d, up)) / sqrt(1.0 - 0.982 * 0.982);
      float r2 = dot(q, q);
      if (r2 < 1.0) {
        vec3 n = normalize(rt * q.x + up * q.y + planetDir * -sqrt(1.0 - r2));
        float band = sin(q.y * 26.0 + sin(q.x * 3.0 + q.y * 7.0) * 1.6) * 0.5 + 0.5;
        vec3 pc = mix(vec3(0.16, 0.13, 0.17), vec3(0.42, 0.5, 0.36), band);
        float lit = clamp(dot(-n, sunDir) * 0.9 + 0.12, 0.05, 1.0);
        float edge = smoothstep(1.0, 0.94, r2);
        col = mix(col, pc * lit, edge * 0.92);
      }
    }
    // Moons: a large pale one and a small rust-coloured one.
    float m1 = smoothstep(0.9994, 0.9996, dot(d, moonDir));
    float m2 = smoothstep(0.99985, 0.9999, dot(d, moon2Dir));
    col = mix(col, vec3(0.86, 0.9, 0.95), m1 * (0.25 + night * 0.75));
    col = mix(col, vec3(0.8, 0.45, 0.32), m2 * (0.25 + night * 0.75));
    // Stars, only at night and away from the horizon.
    vec3 cell = floor(d * 260.0);
    float st = step(0.9965, hash(cell)) * hash(cell + 7.0);
    col += vec3(st) * (0.12 + night * 0.88) * smoothstep(0.02, 0.25, d.y) * (1.0 - m1); // faint even by day
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
    planetDir: { value: new THREE.Vector3(-0.45, 0.32, -0.83).normalize() },
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
    const sunI = 2.0 * sunUp; // a dim, distant sun
    this.sun.color.copy(this.tmp.setRGB(1, 0.5, 0.32)).lerp(new THREE.Color(0.95, 0.9, 0.72), dayW);
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
