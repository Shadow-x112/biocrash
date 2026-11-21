// The crashed station module: a Blender-built model (art/blender/bc_wreck_asset.py) half buried beside the spawn
// point. Solid (a trimesh from its collision mesh), with its red warning beacons and lit window throwing light.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type RAPIER from '@dimforge/rapier3d';

const HALF_LEN = 8.6, HALF_WIDTH = 3.6;

export class Wreck {
  readonly group = new THREE.Group();
  readonly center = new THREE.Vector3();
  private yaw: number;
  private beacons: THREE.PointLight[] = [];
  private t = 0;

  private placed = false;
  private pending: THREE.Mesh | null = null;

  constructor(private rapier: typeof RAPIER, private physics: RAPIER.World, renderer: THREE.WebGLRenderer, spawn: THREE.Vector3,
    private ground: (x: number, z: number) => number | null) {
    // Beside the spawn, nose torn open and pointing away from it. It's seated once the ground under it exists.
    this.yaw = 0.55;
    this.center.set(spawn.x + 7.5, spawn.y, spawn.z + 2.5);
    this.group.visible = false;
    const env = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    new GLTFLoader().load('models/wreck.json', (gltf) => {
      const root = gltf.scene;
      this.group.add(root);
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if (m.name.startsWith('COL_')) { this.pending = m; m.visible = false; return; }
        m.castShadow = m.name !== 'Wreck_Lights';
        m.receiveShadow = true;
        const mat = m.material as THREE.MeshStandardMaterial;
        // A faint reflection environment so the metal reads as metal at night (without one it renders black).
        mat.envMap = env; mat.envMapIntensity = 0.25;
      });
    });
    // Light from the beacons and the window, so the wreck lights its own patch of ground.
    const local = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y); // Blender (Z up) -> three (Y up)
    for (const [p, c, i, d] of [[local(3.6, -2.4, 2.3), 0xff1a08, 6, 12], [local(-2.8, -3.6, 0.9), 0x40e8ff, 3, 9]] as const) {
      const l = new THREE.PointLight(c, i, d, 2);
      l.position.copy(p);
      this.group.add(l);
      if (c === 0xff1a08) this.beacons.push(l);
    }
  }

  /** Solid: a fixed trimesh from the (hidden) collision mesh, in world space. */
  private collider(m: THREE.Mesh) {
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    const pos = g.getAttribute('position').array as Float32Array;
    const idx = g.index ? new Uint32Array(g.index.array) : new Uint32Array([...Array(pos.length / 3).keys()]);
    this.physics.createCollider(this.rapier.ColliderDesc.trimesh(new Float32Array(pos), idx));
  }

  /** Inside the wreck's footprint (keeps mushrooms, stones and fiber from growing through it). */
  covers(x: number, z: number, margin = 1.5) {
    const dx = x - this.center.x, dz = z - this.center.z;
    const ax = Math.cos(this.yaw), az = -Math.sin(this.yaw);
    const along = dx * ax + dz * az, side = -dx * az + dz * ax;
    return Math.abs(along) < HALF_LEN + margin && Math.abs(side) < HALF_WIDTH + margin;
  }

  /** Seats the wreck on the real ground (physics rays), once the terrain colliders under it exist. */
  private seat() {
    const ax = Math.cos(this.yaw), az = -Math.sin(this.yaw);
    const hTail = this.ground(this.center.x - ax * HALF_LEN, this.center.z - az * HALF_LEN);
    const hNose = this.ground(this.center.x + ax * HALF_LEN, this.center.z + az * HALF_LEN);
    const hMid = this.ground(this.center.x, this.center.z);
    if (hTail === null || hNose === null || hMid === null || !this.pending) return;
    this.center.y = Math.min(hMid, (hTail + hNose) / 2) + 0.5; // about a third of the hull below ground
    const pitch = Math.atan2(hNose - hTail, HALF_LEN * 2) - 0.06; // follows the slope, nose dug in a little
    this.group.position.copy(this.center);
    this.group.rotation.set(0.12, this.yaw, pitch, 'YXZ');
    this.group.updateMatrixWorld(true);
    this.collider(this.pending);
    this.group.visible = true;
    this.placed = true;
  }

  update(dt: number) {
    if (!this.placed) this.seat();
    // The beacon pulses: a slow, uneven warning blink.
    this.t += dt;
    const k = Math.max(0, Math.sin(this.t * 2.1)) ** 3 * 0.85 + 0.15;
    for (const b of this.beacons) b.intensity = 6 * k;
  }
}
