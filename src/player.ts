// First-person survivor: mouse look, WASD, jump, sneak, Rapier character controller.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Input } from './input';

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
  /** True while the ground under the player is still loading. */
  frozen = true;
  /** Fallback when pointer lock is blocked: drag with the mouse to look. */
  dragLook = false;
  /** Multiplier on walk/run speed (cold slows you down). */
  speedMul = 1;
  /** Holding C: lower, slower and quieter (creatures notice you later). */
  crouching = false;
  sensitivity = 0.0022;
  private eyeOffset = EYE;
  private velY = 0;
  private grounded = false;
  private dragging = false;
  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();
  private move = new THREE.Vector3();

  constructor(rapier: typeof RAPIER, physics: RAPIER.World, private camera: THREE.PerspectiveCamera, private input: Input) {
    this.body = physics.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased());
    this.collider = physics.createCollider(rapier.ColliderDesc.capsule(HALF_HEIGHT, RADIUS), this.body);
    this.controller = physics.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setSlideEnabled(true);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.controller.enableAutostep(0.45, 0.2, false);
    this.controller.enableSnapToGround(0.4);

    window.addEventListener('mousedown', (e) => { if (e.button === 0) this.dragging = true; });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!this.input.enabled) return;
      if (document.pointerLockElement === null && !(this.dragLook && this.dragging)) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    });
  }

  teleport(p: THREE.Vector3) {
    this.position.copy(p);
    this.body.setNextKinematicTranslation(p);
    this.body.setTranslation(p, true);
    this.velY = 0;
  }

  update(dt: number) {
    const inp = this.input;
    // Arrow keys also look around, so the game is playable without mouse capture.
    const turn = 2.2 * dt;
    if (inp.down('lookLeft')) this.yaw += turn;
    if (inp.down('lookRight')) this.yaw -= turn;
    if (inp.down('lookUp')) this.pitch = Math.min(1.55, this.pitch + turn);
    if (inp.down('lookDown')) this.pitch = Math.max(-1.55, this.pitch - turn);

    if (!this.frozen) {
      this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this.right.set(-this.forward.z, 0, this.forward.x);
      this.move.set(0, 0, 0);
      if (inp.down('forward')) this.move.add(this.forward);
      if (inp.down('back')) this.move.sub(this.forward);
      if (inp.down('right')) this.move.add(this.right);
      if (inp.down('left')) this.move.sub(this.right);
      this.crouching = inp.down('sneak');
      const pace = this.crouching ? WALK * 0.45 : inp.down('run') ? RUN : WALK;
      if (this.move.lengthSq() > 0) this.move.normalize().multiplyScalar(pace * this.speedMul);

      if (this.grounded && inp.down('jump')) this.velY = JUMP;
      this.velY -= GRAVITY * dt;
      if (this.grounded && this.velY < 0) this.velY = -2; // keep pressed to the ground on slopes

      const desired = { x: this.move.x * dt, y: this.velY * dt, z: this.move.z * dt };
      this.controller.computeColliderMovement(this.collider, desired);
      const out = this.controller.computedMovement();
      this.grounded = this.controller.computedGrounded();
      if (this.grounded && this.velY < 0) this.velY = 0;
      if (this.velY > 0 && out.y < desired.y * 0.5) this.velY = 0; // bumped head on a ceiling

      this.position.set(this.position.x + out.x, this.position.y + out.y, this.position.z + out.z);
      this.body.setNextKinematicTranslation(this.position);
    }
    this.eyeOffset += ((this.crouching ? EYE - 0.55 : EYE) - this.eyeOffset) * Math.min(1, dt * 10);
    this.camera.position.set(this.position.x, this.position.y + this.eyeOffset, this.position.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
