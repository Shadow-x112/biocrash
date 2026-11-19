// First-person survivor: mouse look, WASD, jump, sneak, Rapier character controller.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d';
import type { Input } from './input';

const RADIUS = 0.35;
const HALF_HEIGHT = 0.55;
const EYE = 0.7; // eye height above the capsule centre
const WALK = 4.5;
const RUN = 8;
const JUMP = 7;
const GRAVITY = 22;
const COYOTE = 0.1;      // can still jump this long after walking off a ledge
const JUMP_BUFFER = 0.12; // a jump pressed this early before landing still happens
const ACCEL_GROUND = 30, ACCEL_AIR = 8;
const STEP_WALK = 1.7, STEP_RUN = 2.3, STEP_SNEAK = 1.2; // metres between footsteps
const BOB = 0.035;

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
  baseFov = 75;
  headBob = true;
  /** Sound/feel hooks set by the game. */
  onStep?: (run: boolean, sneak: boolean) => void;
  onJump?: () => void;
  onLand?: (impact: number) => void;
  private eyeOffset = EYE;
  private vel = new THREE.Vector3(); // horizontal velocity
  private coyote = 0;
  private jumpBuffer = 0;
  private jumpHeld = false;
  private stride = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private landDip = 0;
  private shakeAmt = 0;
  private fovKick = 0;
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
    this.vel.set(0, 0, 0);
  }

  /** A short camera shake (hits, heavy landings). */
  shake(amount: number) { this.shakeAmt = Math.max(this.shakeAmt, amount); }

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
      const running = inp.down('run') && !this.crouching;
      const pace = this.crouching ? WALK * 0.45 : running ? RUN : WALK;
      if (this.move.lengthSq() > 0) this.move.normalize().multiplyScalar(pace * this.speedMul);
      // Ease toward the wanted speed: quick on the ground, floaty in the air.
      const accel = (this.grounded ? ACCEL_GROUND : ACCEL_AIR) * dt;
      const dx = this.move.x - this.vel.x, dz = this.move.z - this.vel.z, dl = Math.hypot(dx, dz);
      if (dl <= accel) this.vel.set(this.move.x, 0, this.move.z);
      else { this.vel.x += (dx / dl) * accel; this.vel.z += (dz / dl) * accel; }

      // Jump with coyote time and a small input buffer.
      const jumpDown = inp.down('jump');
      if (jumpDown && !this.jumpHeld) this.jumpBuffer = JUMP_BUFFER;
      this.jumpHeld = jumpDown;
      this.coyote = this.grounded ? COYOTE : this.coyote - dt;
      this.jumpBuffer -= dt;
      if (this.jumpBuffer > 0 && this.coyote > 0) {
        this.velY = JUMP; this.coyote = 0; this.jumpBuffer = 0; this.grounded = false;
        this.onJump?.();
      }
      const fallSpeed = -this.velY;
      this.velY -= GRAVITY * dt;
      if (this.grounded && this.velY < 0) this.velY = -2; // keep pressed to the ground on slopes

      const desired = { x: this.vel.x * dt, y: this.velY * dt, z: this.vel.z * dt };
      this.controller.computeColliderMovement(this.collider, desired);
      const out = this.controller.computedMovement();
      const wasGrounded = this.grounded;
      this.grounded = this.controller.computedGrounded();
      if (this.grounded && !wasGrounded && fallSpeed > 4) {
        const impact = fallSpeed;
        this.landDip = Math.min(0.25, impact * 0.018);
        if (impact > 12) this.shake(Math.min(0.5, (impact - 12) * 0.05));
        this.onLand?.(impact);
      }
      if (this.grounded && this.velY < 0) this.velY = 0;
      if (this.velY > 0 && out.y < desired.y * 0.5) this.velY = 0; // bumped head on a ceiling

      // Footsteps and head bob follow the distance actually walked.
      const moved = this.grounded ? Math.hypot(out.x, out.z) : 0;
      const speed = moved / Math.max(dt, 1e-4);
      this.stride += moved;
      const stepLen = this.crouching ? STEP_SNEAK : running ? STEP_RUN : STEP_WALK;
      if (this.stride >= stepLen) { this.stride -= stepLen; this.onStep?.(running, this.crouching); }
      this.bobPhase += (moved / stepLen) * Math.PI;
      this.bobAmp += ((speed > 0.5 ? Math.min(1.3, speed / WALK) : 0) - this.bobAmp) * Math.min(1, dt * 8);
      this.fovKick += ((running && speed > WALK + 0.5 ? 7 : 0) - this.fovKick) * Math.min(1, dt * 6);

      this.position.set(this.position.x + out.x, this.position.y + out.y, this.position.z + out.z);
      this.body.setNextKinematicTranslation(this.position);
    }
    this.eyeOffset += ((this.crouching ? EYE - 0.55 : EYE) - this.eyeOffset) * Math.min(1, dt * 10);
    this.landDip *= Math.max(0, 1 - dt * 7);
    const bob = this.headBob ? this.bobAmp * BOB : 0;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * bob * 1.4 - bob * 0.7;
    const bobX = Math.cos(this.bobPhase) * bob * 0.6;
    let sx = 0, sy = 0;
    if (this.shakeAmt > 0.001) {
      sx = (Math.random() - 0.5) * this.shakeAmt * 0.06; sy = (Math.random() - 0.5) * this.shakeAmt * 0.06;
      this.shakeAmt *= Math.max(0, 1 - dt * 9);
    }
    this.camera.position.set(this.position.x, this.position.y + this.eyeOffset + bobY - this.landDip, this.position.z);
    this.camera.rotation.set(this.pitch + sy, this.yaw + sx, 0, 'YXZ');
    this.camera.translateX(bobX);
    const fov = this.baseFov + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }
}
