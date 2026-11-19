// Short-lived debris: dirt chunks when digging, sparks and bits when hitting. One instanced mesh, no allocations per frame.
import * as THREE from 'three';

const MAX = 256;

export class Particles {
  readonly mesh: THREE.InstancedMesh;
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private next = 0;
  private live = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private v = new THREE.Vector3();
  private c = new THREE.Color();
  private tc = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const geo = new THREE.TetrahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    for (let i = 0; i < MAX; i++) this.mesh.setColorAt(i, this.c.set(0xffffff));
    scene.add(this.mesh);
  }

  /** Burst of n bits at p, thrown along `up` with some spread. */
  burst(p: THREE.Vector3, n: number, color: THREE.ColorRepresentation, o: { up?: THREE.Vector3; speed?: number; size?: number; life?: number } = {}) {
    const up = o.up ?? this.v.set(0, 1, 0), speed = o.speed ?? 3.5, size = o.size ?? 0.07, life = o.life ?? 0.8;
    const base = this.c.set(color);
    for (let k = 0; k < n; k++) {
      const i = this.next; this.next = (this.next + 1) % MAX;
      const i3 = i * 3;
      this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.vel[i3] = (up.x + (Math.random() - 0.5) * 1.6) * sp;
      this.vel[i3 + 1] = (up.y + Math.random() * 0.8) * sp;
      this.vel[i3 + 2] = (up.z + (Math.random() - 0.5) * 1.6) * sp;
      this.life[i] = this.maxLife[i] = life * (0.6 + Math.random() * 0.6);
      this.size[i] = size * (0.6 + Math.random() * 0.8);
      const shade = 0.75 + Math.random() * 0.4;
      this.mesh.setColorAt(i, this.tc.setRGB(base.r * shade, base.g * shade, base.b * shade));
    }
    this.live = MAX; // rescan; cheap at this size
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    if (!this.live) return;
    let any = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) { this.m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, this.m); continue; }
      any++;
      this.life[i] -= dt;
      const i3 = i * 3;
      this.vel[i3 + 1] -= 14 * dt;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      const sz = this.size[i] * Math.min(1, k * 3);
      this.q.setFromAxisAngle(this.v.set(0.3, 1, 0.5).normalize(), this.life[i] * 9 + i);
      this.m.compose(this.s.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]), this.q, this.v.set(sz, sz, sz));
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.count = any ? MAX : 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!any) this.live = 0;
  }
}
