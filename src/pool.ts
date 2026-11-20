// One InstancedMesh shared by every chunk for a given kind of object: a handful of draw calls in total
// instead of several per chunk. Slots are handed out and returned; freed slots are scaled to zero.
import * as THREE from 'three';

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class InstancePool {
  mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private used = 0;
  private dirtyBounds = true;
  private colored: boolean;

  constructor(private geometry: THREE.BufferGeometry, private material: THREE.Material, private parent: THREE.Object3D, capacity = 512, colored = false, private castShadow = false) {
    this.colored = colored;
    this.mesh = this.make(capacity);
    parent.add(this.mesh);
  }

  private make(capacity: number) {
    const m = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    m.count = 0;
    m.frustumCulled = false; // spans the whole loaded world; culling per pool would never cull anything
    m.castShadow = this.castShadow;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this.colored) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    return m;
  }

  private grow() {
    const old = this.mesh;
    const next = this.make(old.instanceMatrix.count * 2);
    (next.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    if (this.colored && old.instanceColor && next.instanceColor) (next.instanceColor.array as Float32Array).set(old.instanceColor.array as Float32Array);
    next.count = old.count;
    next.userData = old.userData;
    this.parent.remove(old);
    old.dispose();
    this.parent.add(next);
    this.mesh = next;
  }

  /** Take a slot and place an instance in it. Returns the slot index. */
  alloc(matrix: THREE.Matrix4, color?: THREE.Color) {
    let i = this.free.pop();
    if (i === undefined) {
      if (this.used >= this.mesh.instanceMatrix.count) this.grow();
      i = this.used++;
      this.mesh.count = this.used;
    }
    this.mesh.setMatrixAt(i, matrix);
    if (color && this.mesh.instanceColor) { this.mesh.setColorAt(i, color); this.mesh.instanceColor.needsUpdate = true; }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirtyBounds = true;
    return i;
  }

  /** Move or reshape an instance in place. */
  set(i: number, matrix: THREE.Matrix4) {
    this.mesh.setMatrixAt(i, matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirtyBounds = true;
  }

  /** Hide an instance and give its slot back. */
  release(i: number) {
    this.mesh.setMatrixAt(i, ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.free.push(i);
    this.dirtyBounds = true;
  }

  /** Raycasts need up-to-date bounds; recompute only after changes. */
  prepareRaycast() {
    if (!this.dirtyBounds) return;
    this.mesh.computeBoundingSphere();
    this.mesh.computeBoundingBox();
    this.dirtyBounds = false;
  }

  /** Live slots in use (for the debug overlay). */
  get size() { return this.used - this.free.length; }
}
