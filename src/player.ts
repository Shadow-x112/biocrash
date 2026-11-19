// First-person survivor: pointer-lock mouse look, WASD, jump, Rapier character controller.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

const RADIUS = 0.35;
const HALF_HEIGHT = 0.55;
const EYE = 0.7; // eye height above the capsule centre
const WALK = 4.5;
const RUN = 8;
const JUMP = 7;
const GRAVITY = 22;

export class Player {
  readonly position = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  frozen = true;
  /** Fallback when pointer lock is blocked (e.g. inside an embedded page): drag with the mouse to look. */
  dragLook = false;
  private dragging = false;
  private velY = 0;
  private grounded = false;
  private keys = new Set<string>();
  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;

  constructor(rapier: typeof RAPIER, physics: RAPIER.World, private camera: THREE.PerspectiveCamera) {
    this.body = physics.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased());
    this.collider = physics.createCollider(rapier.ColliderDesc.capsule(HALF_HEIGHT, RADIUS), this.body);
    this.controller = physics.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setSlideEnabled(true);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.controller.enableAutostep(0.45, 0.2, false);
    this.controller.enableSnapToGround(0.4);

    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('mousedown', (e) => { if (e.button === 0) this.dragging = true; });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === null && !(this.dragLook && this.dragging)) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    });
  }

  teleport(p: THREE.Vector3) {
    this.position.copy(p);
    this.body.setNextKinematicTranslation(p);
    this.body.setTranslation(p, true);
    this.velY = 0;
  }

  isDown(code: string) { return this.keys.has(code); }

  update(dt: number) {
    // Arrow keys also look around, so the game is playable without mouse capture.
    const turn = 2.2 * dt;
    if (this.keys.has('ArrowLeft')) this.yaw += turn;
    if (this.keys.has('ArrowRight')) this.yaw -= turn;
    if (this.keys.has('ArrowUp')) this.pitch = Math.min(1.55, this.pitch + turn);
    if (this.keys.has('ArrowDown')) this.pitch = Math.max(-1.55, this.pitch - turn);
    if (!this.frozen) {
      const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(-forward.z, 0, forward.x);
      const move = new THREE.Vector3();
      if (this.keys.has('KeyW')) move.add(forward);
      if (this.keys.has('KeyS')) move.sub(forward);
      if (this.keys.has('KeyD')) move.add(right);
      if (this.keys.has('KeyA')) move.sub(right);
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(this.keys.has('ShiftLeft') ? RUN : WALK);

      if (this.grounded && this.keys.has('Space')) this.velY = JUMP;
      this.velY -= GRAVITY * dt;
      if (this.grounded && this.velY < 0) this.velY = -2; // keep pressed to the ground on slopes

      const desired = { x: move.x * dt, y: this.velY * dt, z: move.z * dt };
      this.controller.computeColliderMovement(this.collider, desired);
      const out = this.controller.computedMovement();
      this.grounded = this.controller.computedGrounded();
      if (this.grounded && this.velY < 0) this.velY = 0;
      if (this.velY > 0 && out.y < desired.y * 0.5) this.velY = 0; // bumped head on a ceiling

      this.position.set(this.position.x + out.x, this.position.y + out.y, this.position.z + out.z);
      this.body.setNextKinematicTranslation(this.position);
    }
    this.camera.position.set(this.position.x, this.position.y + EYE, this.position.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
