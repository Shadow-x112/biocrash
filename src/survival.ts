// Survival stats for M1 step 2: health and body warmth driven by the air temperature around you.
// Temperature is the main pressure in Biocrash: nights freeze, caves and overhangs shelter, fire warms.
import * as THREE from 'three';

export interface HeatSource { position: THREE.Vector3; radius: number; heatC: number; }

export const TEMP = {
  dayC: 24,          // open ground at midday
  nightC: -14,       // open ground in the middle of the night
  shadeC: -6,        // daytime shade compared with full sun
  shelterC: 5,       // caves and overhangs hold this: it slows the cold, only fire stops it
  lapseCPerM: 0.12,  // colder with height above LAPSE_FROM
  lapseFrom: 30,
  comfortC: 12,      // at or above this you slowly warm up
  loseRate: 0.35,    // warmth lost per second per °C below comfort
  gainRate: 4,       // warmth regained per second when comfortable
  freezeDamage: 3,   // health lost per second at zero warmth
  regen: 0.15,       // health regained per second when warm
  fedRegen: 0.8,     // ...and when warm and fed
  fedTime: 300,      // seconds one cooked meat keeps you fed
};

export class Survival {
  health = 100;
  /** 0..100 body warmth. Below 30 you are cold and slow; at 0 you freeze. */
  warmth = 100;
  ambientC = 20;
  sheltered = false;
  shaded = false;
  readonly heatSources: HeatSource[] = [];
  /** Seconds of "fed" left: faster healing and slower heat loss. */
  fed = 0;
  /** Wearing a hide wrap: heat loss x0.6. */
  wrapped = false;
  /** Seconds after a respawn with slower heat loss, so penalties don't stack up. */
  afterglow = 0;
  private probeTimer = 0;
  private ray = new THREE.Raycaster();

  get cold() { return this.warmth < 30; }
  get dead() { return this.health <= 0; }

  reset() { this.health = 100; this.warmth = 100; this.fed = 0; this.afterglow = 0; }

  /** Back at the crash site after freezing: half health, some warmth, two minutes of grace. */
  respawn() { this.health = 50; this.warmth = 60; this.fed = 0; this.afterglow = 120; }

  /** Multiplier on heat loss from food, clothing and respawn grace. */
  lossFactor() { return (this.wrapped ? 0.75 : 1) * (this.fed > 0 ? 0.85 : 1) * (this.afterglow > 0 ? 0.5 : 1); }

  /** Speed multiplier for the player (cold makes you sluggish). */
  moveFactor() { return this.cold ? 0.7 + (this.warmth / 30) * 0.3 : 1; }

  update(dt: number, ctx: { eye: THREE.Vector3; sunDir: THREE.Vector3; daylight: number; meshes: THREE.Object3D[] }) {
    // Expensive checks (is the sky above you? is the sun blocked?) run a few times a second.
    if ((this.probeTimer -= dt) <= 0) {
      this.probeTimer = 0.4;
      this.ray.far = 40;
      this.ray.set(ctx.eye, new THREE.Vector3(0, 1, 0));
      this.sheltered = this.ray.intersectObjects(ctx.meshes, false).length > 0;
      this.ray.far = 120;
      this.ray.set(ctx.eye, ctx.sunDir);
      this.shaded = ctx.sunDir.y > 0 && this.ray.intersectObjects(ctx.meshes, false).length > 0;
    }

    // Open-air temperature follows the sun, then shade, shelter and height adjust it.
    let t = THREE.MathUtils.lerp(TEMP.nightC, TEMP.dayC, ctx.daylight);
    if (this.shaded) t += TEMP.shadeC * ctx.daylight;
    // Shelter only ever helps: it holds the air near 5 °C on a cold night, but a cave at noon is no colder than outside.
    if (this.sheltered) t = Math.max(t, THREE.MathUtils.lerp(t, TEMP.shelterC, 0.85));
    t -= Math.max(0, ctx.eye.y - TEMP.lapseFrom) * TEMP.lapseCPerM;
    for (const h of this.heatSources) {
      const d = h.position.distanceTo(ctx.eye);
      if (d < h.radius) t += h.heatC * (1 - d / h.radius);
    }
    // Smooth so walking under a branch doesn't flicker the reading.
    this.ambientC += (t - this.ambientC) * Math.min(1, dt * 1.5);

    this.fed = Math.max(0, this.fed - dt);
    this.afterglow = Math.max(0, this.afterglow - dt);
    if (this.ambientC < TEMP.comfortC) this.warmth -= (TEMP.comfortC - this.ambientC) * TEMP.loseRate * this.lossFactor() * dt / 10;
    else this.warmth += TEMP.gainRate * dt * Math.min(1, (this.ambientC - TEMP.comfortC) / 6 + 0.3);
    this.warmth = THREE.MathUtils.clamp(this.warmth, 0, 100);

    if (this.warmth <= 0) this.health -= TEMP.freezeDamage * dt;
    else if (this.warmth > 50) this.health += (this.fed > 0 ? TEMP.fedRegen : TEMP.regen) * dt;
    this.health = THREE.MathUtils.clamp(this.health, 0, 100);
  }
}
