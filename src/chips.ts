// Data chips: station memory thrown clear of the wreck. Each one, read with E, teaches a piece of station tech.
// They sit at fixed spots around the crash site (the same for every world) and glow teal so they can be found at night.
import * as THREE from 'three';
import { glowSprite } from './placeables';

export const CHIPS = [
  { id: 'chip_cell', name: 'power cell schematics', off: [17, -11] },
  { id: 'chip_flare', name: 'signal flare formula', off: [-22, 8] },
  { id: 'chip_solar', name: 'solar array schematics', off: [9, 27] },
] as const;
export type ChipId = (typeof CHIPS)[number]['id'];

interface Chip { id: ChipId; name: string; group: THREE.Group; mesh: THREE.Mesh; glow: THREE.Sprite; placed: boolean; x: number; z: number }

let look: { geometry: THREE.BufferGeometry; material: THREE.Material } = {
  geometry: new THREE.BoxGeometry(0.14, 0.008, 0.09).translate(0, 0.004, 0),
  material: new THREE.MeshStandardMaterial({ color: 0x0a1a16, emissive: 0x30ffd0, emissiveIntensity: 0.6, metalness: 0.5, roughness: 0.4 }),
};
const TEAL = new THREE.Color(0.25, 1.0, 0.85);

export class Chips {
  readonly group = new THREE.Group();
  readonly list: Chip[] = [];
  private ray = new THREE.Ray();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 0.3);
  private t = 0;
  /** Spots a chip can't lie on (inside a mushroom trunk: it couldn't be reached or read). */
  blocked?: (x: number, z: number) => boolean;

  /** `taken`: chips already read (they're gone from the world). `wreck`: chips wait for it to settle, then keep off it. */
  constructor(centre: THREE.Vector3, taken: (id: string) => boolean, private wreck?: { placed: boolean; center: THREE.Vector3; covers: (x: number, z: number) => boolean }) {
    for (const c of CHIPS) {
      if (taken(c.id)) continue;
      const g = new THREE.Group(); g.visible = false;
      const mesh = new THREE.Mesh(look.geometry, look.material);
      const glow = glowSprite(TEAL, 0.45); glow.position.y = 0.08;
      g.add(mesh, glow); this.group.add(g);
      this.list.push({ id: c.id, name: c.name, group: g, mesh, glow, placed: false, x: centre.x + c.off[0], z: centre.z + c.off[1] });
    }
  }

  setLook(m: { geometry: THREE.BufferGeometry; material: THREE.Material } | undefined) {
    if (!m) return;
    look = m;
    for (const c of this.list) { c.mesh.geometry = m.geometry; c.mesh.material = m.material; }
  }

  /** Seats chips on the ground once their chunk has loaded, and makes them shimmer. */
  update(dt: number, ground: (x: number, z: number) => { y: number } | null) {
    this.t += dt;
    for (const [i, c] of this.list.entries()) {
      if (!c.placed) {
        // Wait for the wreck to settle (it picks its spot after load), then push the chip out of its footprint, away
        // from its centre (pushing away from the world origin could leave it under the hull).
        if (this.wreck && !this.wreck.placed) continue;
        for (let k = 0; k < 8 && this.wreck?.covers(c.x, c.z); k++) {
          const dx = c.x - this.wreck.center.x, dz = c.z - this.wreck.center.z, d = Math.hypot(dx, dz) || 1;
          c.x += (dx / d) * 3; c.z += (dz / d) * 3;
        }
        // Out of a mushroom foot: try a ring of spots around it, nearest first.
        if (this.blocked?.(c.x, c.z)) {
          let moved = false;
          for (let r = 1; r <= 4 && !moved; r++) for (let a = 0; a < 8 && !moved; a++) {
            const x = c.x + Math.cos(a * Math.PI / 4) * r * 1.5, z = c.z + Math.sin(a * Math.PI / 4) * r * 1.5;
            if (!this.blocked(x, z) && !this.wreck?.covers(x, z)) { c.x = x; c.z = z; moved = true; }
          }
        }
        const g = ground(c.x, c.z);
        if (!g) continue;
        // Lie flat on the slope (normal from two nearby ground samples).
        const gx = ground(c.x + 0.3, c.z), gz = ground(c.x, c.z + 0.3), up = new THREE.Vector3(0, 1, 0);
        const n = gx && gz ? new THREE.Vector3(-(gx.y - g.y) / 0.3, 1, -(gz.y - g.y) / 0.3).normalize() : up;
        c.group.position.set(c.x, g.y + 0.005, c.z);
        c.group.quaternion.setFromUnitVectors(up, n).multiply(new THREE.Quaternion().setFromAxisAngle(up, i * 2.1 + 0.6));
        c.group.visible = true; c.placed = true;
      }
      const k = 0.55 + 0.45 * Math.sin(this.t * 2.2 + i * 1.7);
      c.glow.material.opacity = 0.35 + 0.5 * k;
    }
  }

  /** The chip under the crosshair within reach. */
  lookAt(camera: THREE.Camera, reach: number) {
    camera.getWorldPosition(this.ray.origin); camera.getWorldDirection(this.ray.direction);
    let best: Chip | null = null, bestD = reach;
    for (const c of this.list) {
      if (!c.placed) continue;
      this.sphere.center.copy(c.group.position).y += 0.05;
      const hit = this.ray.intersectSphere(this.sphere, new THREE.Vector3());
      if (hit) { const d = hit.distanceTo(this.ray.origin); if (d < bestD) { bestD = d; best = c; } }
    }
    return best;
  }

  take(c: Chip) {
    const i = this.list.indexOf(c);
    if (i >= 0) this.list.splice(i, 1);
    this.group.remove(c.group);
  }

  /** Nearest chip still in the world (for the compass / wrist hint). */
  nearest(p: THREE.Vector3) {
    let best: Chip | null = null, bd = Infinity;
    for (const c of this.list) { const d = Math.hypot(c.x - p.x, c.z - p.z); if (d < bd) { bd = d; best = c; } }
    return best ? { chip: best, dist: bd } : null;
  }
}
