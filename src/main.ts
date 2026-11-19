// Biocrash M0 tech test: walk, dig, collide and save on smooth terrain.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { World } from './terrain/world';
import { createGenerator } from './terrain/density';
import { Player } from './player';
import { Sky } from './sky';
import { Survival } from './survival';
import { Props } from './props';
import { Inventory, ITEM_NAMES, type ItemId } from './inventory';
import { Campfires, CAMPFIRE_COST, FUEL_MAX } from './campfire';
import { SaveStore, type SaveMeta } from './save';
import { CHUNK, VIEW_RADIUS, DIG_RADIUS, DIG_STRENGTH, REACH, GEN_VERSION, SAVE_VERSION } from './config';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const hud = $('hud'), overlay = $('overlay'), status = $('status');

async function main() {
  await RAPIER.init();

  // --- Renderer, scene, lighting -------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x9fb6c9, CHUNK * (VIEW_RADIUS - 1.8), CHUNK * VIEW_RADIUS);
  const sky = new Sky(scene);

  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, CHUNK * (VIEW_RADIUS + 1));
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // --- Save, world, player ---------------------------------------------------------------------
  const store = await SaveStore.open();
  const meta = await store.loadMeta();
  const seed = meta?.seed ?? Math.random().toString(36).slice(2, 10);

  const physics = new RAPIER.World({ x: 0, y: -22, z: 0 });
  const world = new World(seed, RAPIER, physics);
  scene.add(world.group);
  if (meta) for (const [k, v] of await store.loadChunks()) world.edits.set(k, v);

  const player = new Player(RAPIER, physics, camera);
  if (meta?.player) {
    player.teleport(new THREE.Vector3(meta.player.x, meta.player.y, meta.player.z));
    player.yaw = meta.player.yaw;
    player.pitch = meta.player.pitch;
  }

  // The crash site: where a new world starts and where you recover after freezing.
  const spawnPoint = new THREE.Vector3(0.5, createGenerator(seed).surfaceHeight(0.5, 0.5) + 6, 0.5);
  if (!meta?.player) player.teleport(spawnPoint);
  if (meta?.timeOfDay !== undefined) sky.time = meta.timeOfDay;
  const survival = new Survival();
  if (meta?.vitals) { survival.health = meta.vitals.health; survival.warmth = meta.vitals.warmth; }

  // Gathering and campfires (M1 step 3).
  const props = new Props(seed);
  for (const id of meta?.picked ?? []) props.picked.add(id);
  scene.add(props.group);
  world.onChunkMesh = (key, mesh, cx, cy, cz) => props.onChunkMesh(key, mesh, cx, cy, cz);
  world.onChunkUnload = (key) => props.onChunkUnload(key);
  const inventory = new Inventory();
  const campfires = new Campfires(survival.heatSources);
  scene.add(campfires.group);
  campfires.load(meta?.campfires);
  const currentMeta = (): SaveMeta => ({
    saveVersion: SAVE_VERSION, genVersion: GEN_VERSION, seed, savedAt: Date.now(), timeOfDay: sky.time,
    vitals: { health: survival.health, warmth: survival.warmth },
    inventory: { ...inventory.counts }, picked: [...props.picked], campfires: campfires.save(),
    player: { x: player.position.x, y: player.position.y, z: player.position.z, yaw: player.yaw, pitch: player.pitch },
  });
  let lastSaveMs = 0;
  const saveNow = async () => {
    const t0 = performance.now();
    const dirty = new Map<string, Float32Array>();
    for (const k of world.dirtyEdits) { const e = world.edits.get(k); if (e) dirty.set(k, e); }
    world.dirtyEdits.clear();
    await store.save(currentMeta(), dirty);
    lastSaveMs = performance.now() - t0;
  };
  setInterval(() => { void saveNow(); }, 10_000);
  window.addEventListener('pagehide', () => { void saveNow(); });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') { e.preventDefault(); hud.style.display = hud.style.display === 'none' ? '' : 'none'; }
    if (e.code === 'KeyT') { sky.speed = sky.speed === 1 ? 60 : 1; flash(sky.speed > 1 ? 'Fast time on (T)' : 'Fast time off'); }
  });
  window.addEventListener('keydown', (e) => { if (e.code === 'F5') { e.preventDefault(); void saveNow().then(() => flash('Saved')); } });

  // --- Overlay / pointer lock ------------------------------------------------------------------
  const canvas = renderer.domElement;
  let toastTimer = 0;
  const flash = (msg: string) => {
    status.textContent = msg;
    const t = $('toast');
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { t.style.opacity = '0'; }, 3000);
  };
  let playing = false; // true while the game has focus (mouse captured, or drag-look fallback)
  const startPlay = async () => {
    try {
      await canvas.requestPointerLock({ unadjustedMovement: true });
    } catch {
      try { await canvas.requestPointerLock(); } catch {
        // Mouse capture blocked (embedded page, locked-down browser): drag to look instead.
        player.dragLook = true;
        playing = true;
        overlay.style.display = 'none';
        flash('Mouse capture is blocked here: drag to look, R dig, F fill.');
      }
    }
  };
  $('play').onclick = () => { void startPlay(); };
  document.addEventListener('pointerlockchange', () => {
    playing = document.pointerLockElement === canvas;
    overlay.style.display = playing ? 'none' : 'flex';
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && player.dragLook && playing) { playing = false; overlay.style.display = 'flex'; }
  });
  $('export').onclick = async () => {
    await saveNow();
    const blob = await store.exportFile(currentMeta(), world.edits);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `biocrash-save-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    flash('Save exported');
  };
  $('import').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try { await store.importFile(await f.text()); location.reload(); }
      catch (err) { flash(String((err as Error).message)); }
    };
    input.click();
  };
  $('reset').onclick = async () => {
    if (!confirmReset()) return;
    await store.clear();
    location.reload();
  };
  let resetArmed = false;
  const confirmReset = () => {
    if (resetArmed) return true;
    resetArmed = true;
    flash('Click "New world" again to delete this world.');
    setTimeout(() => { resetArmed = false; }, 4000);
    return false;
  };

  // --- Dig / fill --------------------------------------------------------------------------------
  const ray = new THREE.Raycaster();
  ray.far = REACH;
  const held = { dig: false, fill: false, cooldown: 0 };
  canvas.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== canvas) return; // drag-look mode digs with E/Q instead
    if (e.button === 0) held.dig = true;
    if (e.button === 2) held.fill = true;
    held.cooldown = 0;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) held.dig = false;
    if (e.button === 2) held.fill = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const tryBrush = () => {
    ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hit = ray.intersectObjects(world.meshes(), false)[0];
    if (!hit || !hit.face) return;
    if (held.dig) {
      world.brush(hit.point, DIG_RADIUS, DIG_STRENGTH, -1);
    } else if (held.fill) {
      const p = hit.point.clone().addScaledVector(hit.face.normal, 0.6);
      if (p.distanceTo(player.position) < DIG_RADIUS + 0.9) return; // don't bury yourself
      world.brush(p, DIG_RADIUS, DIG_STRENGTH, +1);
    }
  };

  if (import.meta.env.DEV) Object.assign(window, { __bc: { world, player, camera, saveNow, store, sky, survival, props, inventory, campfires } });

  // --- Vitals HUD -------------------------------------------------------------------------------
  const deathEl = $('death'), frostEl = $('frost');
  const hpBar = document.querySelector('#hp > div') as HTMLElement, heatBar = document.querySelector('#heat > div') as HTMLElement;
  let dying = false;
  const fahrenheit = navigator.language === 'en-US';
  const fmtTemp = (c: number) => (fahrenheit ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`);
  const updateVitals = () => {
    hpBar.style.width = `${survival.health}%`;
    heatBar.style.width = `${survival.warmth}%`;
    heatBar.style.backgroundColor = survival.warmth > 60 ? '#e0a050' : survival.warmth > 30 ? '#c9b98a' : '#8fc3e8';
    $('hpv').textContent = String(Math.ceil(survival.health));
    $('heatlabel').textContent = survival.cold ? 'Body heat · freezing' : 'Body heat';
    $('tempv').textContent = `air ${fmtTemp(survival.ambientC)}${survival.sheltered ? ' · sheltered' : survival.shaded ? ' · shade' : ''}`;
    frostEl.style.opacity = String(Math.max(0, (45 - survival.warmth) / 45));
  };

  // --- Gathering, campfires and the inventory panel ---------------------------------------------
  const promptEl = $('prompt'), invEl = $('inv');
  const renderInv = () => {
    invEl.innerHTML = (Object.keys(inventory.counts) as ItemId[])
      .map((k) => `<div class="row"><span>${ITEM_NAMES[k]}</span><span>${inventory.counts[k]}</span></div>`).join('');
  };
  inventory.onChange = renderInv;
  inventory.load(meta?.inventory as Partial<Record<ItemId, number>> | undefined);
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const look = () => {
    const fire = campfires.lookAt(camera, 3.2);
    const prop = fire ? null : props.lookAt(camera, 3.2);
    return { fire, prop };
  };
  const placeCampfire = () => {
    ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    ray.far = 5;
    const hit = ray.intersectObjects(world.meshes(), false)[0];
    if (!hit?.face || hit.face.normal.y < 0.6) { flash('Look at flat ground nearby to build a campfire.'); return; }
    if (!inventory.take(CAMPFIRE_COST)) {
      flash(`A campfire needs ${CAMPFIRE_COST.stalkwood} stalkwood and ${CAMPFIRE_COST.stone} stone.`);
      return;
    }
    campfires.add(hit.point.clone());
    flash('Campfire built. Add stalkwood (E) to keep it burning.');
  };
  window.addEventListener('keydown', (e) => {
    if (!playing || e.repeat) return;
    if (e.code === 'KeyE') {
      const { fire, prop } = look();
      if (prop) { props.pick(prop); inventory.add(prop.kind); }
      else if (fire) {
        if (fire.fuel >= FUEL_MAX - 1) flash('The fire is fully stoked.');
        else if (inventory.take({ stalkwood: 1 })) campfires.addFuel(fire);
        else flash('You need stalkwood to feed the fire.');
      }
    }
    if (e.code === 'KeyC') placeCampfire();
  });
  const updatePrompt = () => {
    if (!playing) { promptEl.textContent = ''; return; }
    const { fire, prop } = look();
    if (prop) promptEl.textContent = `E  pick up ${ITEM_NAMES[prop.kind].toLowerCase()}`;
    else if (fire) promptEl.textContent = fire.lit ? `E  add stalkwood  ·  burns ${fmtTime(fire.fuel)}` : 'E  relight with stalkwood';
    else promptEl.textContent = '';
  };

  // --- Loop ---------------------------------------------------------------------------------------
  const timer = new THREE.Timer();
  timer.connect(document);
  let fps = 0, frameMs = 0, promptTimer = 0;
  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    const t0 = performance.now();

    world.update(player.position);
    player.frozen = !world.isReadyAt(player.position);
    player.update(dt);
    physics.step();
    sky.update(dt, camera);

    // Survival: warmth follows the air temperature; freezing costs health; death respawns you at the crash site.
    if (!player.frozen && !dying) {
      survival.update(dt, { eye: camera.position, sunDir: sky.sunDir, daylight: sky.daylight, meshes: world.meshes() });
      player.speedMul = survival.moveFactor();
      if (survival.dead) {
        dying = true;
        deathEl.style.display = 'flex';
        setTimeout(() => {
          player.teleport(spawnPoint);
          survival.reset();
          deathEl.style.display = 'none';
          dying = false;
        }, 3000);
      }
    }
    updateVitals();
    campfires.update(dt, player.position);
    if ((promptTimer -= dt) <= 0) { promptTimer = 0.1; updatePrompt(); }

    const keyDig = playing && player.isDown('KeyR'), keyFill = playing && player.isDown('KeyF');
    if (keyDig || keyFill || held.dig || held.fill) {
      if ((held.cooldown -= dt) <= 0) {
        const prev = { dig: held.dig, fill: held.fill };
        if (keyDig) held.dig = true; else if (keyFill) held.fill = true;
        tryBrush();
        held.dig = prev.dig; held.fill = prev.fill;
        held.cooldown = 0.12;
      }
    } else held.cooldown = 0;

    renderer.render(scene, camera);
    frameMs = frameMs * 0.95 + (performance.now() - t0) * 0.05;
    fps = fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

    const p = player.position;
    hud.textContent =
      `FPS ${fps.toFixed(0)}   frame ${frameMs.toFixed(1)} ms\n` +
      `chunks ${world.stats.loaded}  queued ${world.stats.queued}  mesh ${world.stats.meshMs.toFixed(1)} ms\n` +
      `tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k  draws ${renderer.info.render.calls}\n` +
      `pos ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}${player.frozen ? '  (loading ground…)' : ''}\n` +
      `time ${sky.clock()}${sky.speed > 1 ? ' (fast)' : ''}  edited chunks ${world.edits.size}  last save ${lastSaveMs.toFixed(1)} ms\nseed ${seed}`;
  });
}

main().catch((err) => {
  console.error(err);
  hud.textContent = `Failed to start: ${(err as Error).message}`;
});
