// Biocrash: entry point. Builds the world and systems, runs the game-state machine and the frame loop.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { World } from './terrain/world';
import { createGenerator } from './terrain/density';
import { Input } from './input';
import { Player } from './player';
import { Sky } from './sky';
import { Survival } from './survival';
import { Props } from './props';
import { Inventory, ITEM_NAMES, MATERIALS, type ItemId } from './inventory';
import { RECIPES } from './crafting';
import { Hotbar, SLOTS, SLOT_NAMES, DIG_POWER, type Slot } from './tools';
import { Fauna, type Creature } from './creatures';
import { Flora } from './flora';
import { Campfires, CAMPFIRE_COST, FUEL_MAX } from './campfire';
import { SaveStore, type SaveMeta } from './save';
import { CHUNK, VIEW_RADIUS, REACH, GEN_VERSION, SAVE_VERSION, MIN_CY } from './config';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const hud = $('hud'), overlay = $('overlay'), status = $('status');

/** playing: in control. menu: pause screen. craft: crafting panel. dead: recovering. The world only simulates in playing/dead. */
type GameState = 'menu' | 'playing' | 'craft' | 'dead';

const ATTACK: Record<Slot, { reach: number; damage: number }> = {
  hands: { reach: 2.2, damage: 4 }, stone_knife: { reach: 2.3, damage: 12 },
  stone_pick: { reach: 2.5, damage: 10 }, spear: { reach: 3.6, damage: 30 },
};
const USE_REACH = 3.2;

async function main() {
  await RAPIER.init();

  // --- Renderer, scene, camera ---------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.prepend(renderer.domElement);
  const canvas = renderer.domElement;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x9fb6c9, CHUNK * (VIEW_RADIUS - 1.8), CHUNK * VIEW_RADIUS);
  const sky = new Sky(scene);
  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, CHUNK * (VIEW_RADIUS + 1));
  scene.add(camera); // the held tool is a child of the camera
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // --- Load the save ---------------------------------------------------------------------------
  const store = await SaveStore.open();
  const loaded = await store.load();
  const meta = loaded?.meta ?? null;
  const seed = meta?.seed ?? Math.random().toString(36).slice(2, 10);

  // --- World and systems -------------------------------------------------------------------------
  const physics = new RAPIER.World({ x: 0, y: -22, z: 0 });
  const world = new World(seed, RAPIER, physics);
  scene.add(world.group);
  if (loaded) for (const [k, v] of loaded.edits) world.edits.set(k, v);

  const input = new Input(canvas);
  const player = new Player(RAPIER, physics, camera, input);
  const hotbar = new Hotbar(camera);
  // The crash site: where a new world starts and where you recover after freezing.
  const spawnPoint = new THREE.Vector3(0.5, createGenerator(seed).surfaceHeight(0.5, 0.5) + 6, 0.5);
  if (meta?.player) {
    player.teleport(new THREE.Vector3(meta.player.x, meta.player.y, meta.player.z));
    player.yaw = meta.player.yaw;
    player.pitch = meta.player.pitch;
  } else player.teleport(spawnPoint);
  if (meta?.timeOfDay !== undefined) sky.time = meta.timeOfDay;

  const survival = new Survival();
  if (meta?.vitals) { survival.health = meta.vitals.health; survival.warmth = meta.vitals.warmth; }
  const props = new Props();
  for (const id of meta?.picked ?? []) props.picked.add(id);
  scene.add(props.group);
  const flora = new Flora(RAPIER, physics, spawnPoint);
  for (const [k, v] of Object.entries(meta?.stalks ?? {})) flora.harvested.set(k, v);
  scene.add(flora.group);
  world.onChunkMesh = (key, _mesh, deco) => { props.onChunkMesh(key, deco); flora.onChunkMesh(key, deco); };
  world.onChunkUnload = (key) => { props.onChunkUnload(key); flora.onChunkUnload(key); };
  const inventory = new Inventory();
  const campfires = new Campfires(survival.heatSources);
  scene.add(campfires.group);
  campfires.load(meta?.campfires);
  const fauna = new Fauna((x, z) => world.groundAt(x, z));
  scene.add(fauna.group);

  // --- Messages ----------------------------------------------------------------------------------
  let toastTimer = 0;
  const flash = (msg: string) => {
    status.textContent = msg;
    const t = $('toast');
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { t.style.opacity = '0'; }, 3000);
  };
  if (!store.owner) flash('This world is open in another tab. Changes here will not be saved.');

  // --- Saving --------------------------------------------------------------------------------------
  const currentMeta = (): SaveMeta => ({
    saveVersion: SAVE_VERSION, genVersion: GEN_VERSION, seed, savedAt: Date.now(), timeOfDay: sky.time,
    vitals: { health: survival.health, warmth: survival.warmth },
    inventory: { ...inventory.counts }, picked: [...props.picked], campfires: campfires.save(),
    stalks: Object.fromEntries(flora.harvested),
    player: { x: player.position.x, y: player.position.y, z: player.position.z, yaw: player.yaw, pitch: player.pitch },
  });
  let lastSaveMs = 0, saveErrorShown = false;
  const saveNow = async () => {
    if (store.suppressed || !store.owner) return false;
    const t0 = performance.now();
    const keys = [...world.dirtyEdits];
    const dirty = new Map<string, Float32Array>();
    for (const k of keys) { const e = world.edits.get(k); if (e) dirty.set(k, e); }
    world.dirtyEdits.clear();
    try {
      await store.save(currentMeta(), dirty);
      lastSaveMs = performance.now() - t0;
      saveErrorShown = false;
      return true;
    } catch (err) {
      for (const k of keys) world.dirtyEdits.add(k); // keep them for the next attempt
      console.error('Save failed', err);
      if (!saveErrorShown) { flash('Saving failed. Export your save from the pause menu to be safe.'); saveErrorShown = true; }
      return false;
    }
  };
  const autosave = window.setInterval(() => { void saveNow(); }, 10_000);
  window.addEventListener('pagehide', () => { void saveNow(); });
  const stopSaving = () => { store.suppressed = true; clearInterval(autosave); };

  // --- Game state ----------------------------------------------------------------------------------
  let state: GameState = 'menu';
  let lockWorked = false; // once mouse capture has worked, never fall back to drag-look
  const craftEl = $('craft');
  const setState = (s: GameState) => {
    state = s;
    input.enabled = s === 'playing';
    if (s !== 'playing') input.release();
    overlay.style.display = s === 'menu' ? 'flex' : 'none';
    craftEl.style.display = s === 'craft' ? 'flex' : 'none';
    if (s === 'craft') renderCraft();
    if (s !== 'playing') $('prompt').textContent = '';
  };
  const requestLock = () => canvas.requestPointerLock({ unadjustedMovement: true }).catch(() => canvas.requestPointerLock());
  const resume = async () => {
    if (player.dragLook) { setState('playing'); return; }
    try {
      await requestLock();
    } catch {
      if (lockWorked) { flash('Click again to resume.'); return; } // browser cooldown right after Esc
      // Mouse capture blocked here (embedded page, locked-down browser): drag to look instead.
      player.dragLook = true;
      input.mouseActions = false;
      setState('playing');
      flash('Mouse capture is blocked here: drag to look, R dig, F fill.');
    }
  };
  $('play').onclick = () => { void resume(); };
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) {
      lockWorked = true;
      if (state === 'menu') setState('playing');
    } else if (state === 'playing' && !player.dragLook) setState('menu'); // Esc
  });
  // A click on the game takes back a lost mouse capture.
  canvas.addEventListener('mousedown', () => {
    if (state === 'playing' && !player.dragLook && document.pointerLockElement !== canvas) void requestLock().catch(() => {});
  });

  // --- Pause-menu buttons --------------------------------------------------------------------------
  $('export').onclick = async () => {
    await saveNow();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(store.exportFile(currentMeta(), world.edits));
    a.download = `biocrash-save-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    flash('Save exported');
  };
  $('import').onclick = () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'application/json';
    picker.onchange = async () => {
      const f = picker.files?.[0];
      if (!f) return;
      try {
        clearInterval(autosave);
        await store.importFile(await f.text()); // validates fully before replacing anything
        location.reload();
      } catch (err) { flash((err as Error).message); }
    };
    picker.click();
  };
  let resetArmed = false;
  $('reset').onclick = async () => {
    if (!resetArmed) {
      resetArmed = true;
      flash('Click "New world" again to delete this world.');
      setTimeout(() => { resetArmed = false; }, 4000);
      return;
    }
    stopSaving();
    await store.reset();
    location.reload();
  };

  // --- Inventory, hotbar and crafting UI -----------------------------------------------------------
  const invEl = $('inv'), recipesEl = $('recipes');
  function renderHotbar() {
    $('hotbar').innerHTML = SLOTS.map((s, i) => {
      const owned = s === 'hands' || inventory.counts[s] > 0;
      const n = s === 'hands' ? 0 : inventory.counts[s];
      return `<div class="slot${s === hotbar.slot ? ' sel' : ''}${owned ? '' : ' locked'}"><b>${i + 1}${n > 1 ? ' · ×' + n : ''}</b>${SLOT_NAMES[s]}</div>`;
    }).join('');
  }
  function renderCraft() {
    recipesEl.innerHTML = RECIPES.map((r) => {
      const costs = (Object.keys(r.cost) as ItemId[]).map((k) => {
        const ok = inventory.counts[k] >= (r.cost[k] ?? 0);
        return `<span class="${ok ? 'ok' : 'no'}">${r.cost[k]} ${ITEM_NAMES[k].toLowerCase()}</span>`;
      }).join(' · ');
      const name = r.makes === 'campfire' ? 'Campfire' : ITEM_NAMES[r.makes];
      const have = r.makes === 'campfire' ? 0 : inventory.counts[r.makes];
      const btn = r.makes === 'campfire' ? '<span class="hint">press B in the world</span>'
        : `<button data-r="${r.id}" ${inventory.has(r.cost) ? '' : 'disabled'}>Craft</button>`;
      return `<div class="recipe"><div><div class="rname">${name}${r.amount > 1 ? ' ×' + r.amount : ''}${have ? ` <span class="hint">(have ${have})</span>` : ''}</div>
        <div class="rcost">${costs}</div><div class="rblurb">${r.blurb}</div></div>${btn}</div>`;
    }).join('');
  }
  inventory.onChange = () => {
    invEl.innerHTML = MATERIALS.filter((k, i) => i < 3 || inventory.counts[k] > 0)
      .map((k) => `<div class="row"><span>${ITEM_NAMES[k]}</span><span>${inventory.counts[k]}</span></div>`).join('');
    renderHotbar();
    if (state === 'craft') renderCraft();
  };
  hotbar.onChange = renderHotbar;
  inventory.load(meta?.inventory);
  recipesEl.addEventListener('click', (e) => {
    const r = RECIPES.find((x) => x.id === (e.target as HTMLElement).dataset.r);
    if (!r || r.makes === 'campfire' || !inventory.take(r.cost)) return;
    const first = inventory.counts[r.makes] === 0;
    inventory.add(r.makes, r.amount);
    if (r.tool && first) hotbar.select(r.makes as Slot, () => true); // equip your first one
  });

  // --- What you're looking at: one query, used by the prompt and by E ------------------------------
  type Target =
    | { kind: 'creature'; c: Creature }
    | { kind: 'prop'; p: NonNullable<ReturnType<Props['lookAt']>> }
    | { kind: 'fire'; f: NonNullable<ReturnType<Campfires['lookAt']>> }
    | { kind: 'stalk'; s: NonNullable<ReturnType<Flora['lookAt']>> }
    | null;
  let target: Target = null;
  const queryTarget = (): Target => {
    const c = fauna.lookAt(camera, ATTACK.spear.reach);
    if (c) return { kind: 'creature', c };
    const f = campfires.lookAt(camera, USE_REACH);
    if (f) return { kind: 'fire', f };
    const p = props.lookAt(camera, USE_REACH);
    if (p) return { kind: 'prop', p };
    const s = flora.lookAt(camera, USE_REACH);
    if (s) return { kind: 'stalk', s };
    return null;
  };
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const promptFor = (t: Target) => {
    if (!t) return '';
    switch (t.kind) {
      case 'creature':
        return t.c.alive ? t.c.species.name
          : inventory.counts.stone_knife > 0 ? `E  harvest ${t.c.species.name}` : `${t.c.species.name}  ·  needs a stone knife to harvest`;
      case 'prop': return `E  pick up ${ITEM_NAMES[t.p.kind].toLowerCase()}`;
      case 'fire': return t.f.lit ? `E  add stalkwood  ·  burns ${fmtTime(t.f.fuel)}` : 'E  relight with stalkwood';
      case 'stalk': {
        const left = flora.usesLeft(t.s);
        if (left <= 0) return 'Cut back';
        return inventory.counts.stone_knife + inventory.counts.stone_pick > 0 ? `E  cut stalkwood  ·  ${left} left` : 'Stalkwood · needs a knife or pick';
      }
    }
  };

  // --- Actions -----------------------------------------------------------------------------------
  const digRay = new THREE.Raycaster();
  const buildRay = new THREE.Raycaster();
  const centre = new THREE.Vector2(0, 0);
  const use = () => {
    const t = queryTarget();
    if (!t) return;
    if (t.kind === 'creature') {
      if (t.c.alive || t.c.position.distanceTo(player.position) > USE_REACH + 1) return;
      if (inventory.counts.stone_knife <= 0) { flash('You need a stone knife to harvest.'); return; }
      t.c.harvested = true;
      const got: string[] = [];
      for (const [k, n] of Object.entries(t.c.species.drops) as [ItemId, number][]) { inventory.add(k, n); got.push(`${n} ${ITEM_NAMES[k].toLowerCase()}`); }
      hotbar.swing();
      flash(`Harvested ${got.join(', ')}.`);
    } else if (t.kind === 'prop') {
      props.pick(t.p);
      inventory.add(t.p.kind, t.p.kind === 'fiber' && hotbar.slot === 'stone_knife' ? 2 : 1);
      hotbar.swing();
    } else if (t.kind === 'fire') {
      if (t.f.fuel >= FUEL_MAX - 1) flash('The fire is fully stoked.');
      else if (inventory.take({ stalkwood: 1 })) campfires.addFuel(t.f);
      else flash('You need stalkwood to feed the fire.');
    } else if (t.kind === 'stalk') {
      if (inventory.counts.stone_knife <= 0 && inventory.counts.stone_pick <= 0) { flash('Cut stalkwood with a stone knife or pick.'); return; }
      const got = flora.harvest(t.s);
      if (got) { inventory.add('stalkwood', got); hotbar.swing(); } else flash('This stalk has been cut back as far as it goes.');
    }
  };
  const buildCampfire = () => {
    buildRay.setFromCamera(centre, camera);
    buildRay.far = 5;
    const hit = buildRay.intersectObjects(world.meshes(), false)[0];
    if (!hit?.face || hit.face.normal.y < 0.6) { flash('Look at flat ground nearby to build a campfire.'); return; }
    if (!inventory.take(CAMPFIRE_COST)) {
      flash(`A campfire needs ${CAMPFIRE_COST.stalkwood} stalkwood and ${CAMPFIRE_COST.stone} stone.`);
      return;
    }
    campfires.add(hit.point.clone());
    flash('Campfire built. Add stalkwood (E) to keep it burning.');
  };
  const attack = (c: Creature) => {
    hotbar.swing();
    const hit = c.damage(ATTACK[hotbar.slot].damage, player.position);
    if (!hit && c.state === 'curl') flash(`The ${c.species.name} curled into its shell.`);
    else if (!c.alive) flash(`${c.species.name} down. Harvest it with a stone knife (E).`);
  };
  const brush = (fill: boolean) => {
    digRay.setFromCamera(centre, camera);
    digRay.far = REACH;
    const hit = digRay.intersectObjects(world.meshes(), false)[0];
    if (!hit?.face) return;
    const power = DIG_POWER[hotbar.slot];
    if (!fill) world.brush(hit.point, power.radius, power.strength, -1);
    else {
      const p = hit.point.clone().addScaledVector(hit.face.normal, 0.6);
      if (p.distanceTo(player.position) < power.radius + 0.9) return; // don't bury yourself
      world.brush(p, power.radius, power.strength, +1);
    }
  };

  // --- Keys that aren't held actions --------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') { e.preventDefault(); hud.style.display = hud.style.display === 'none' ? '' : 'none'; return; }
    if (e.code === 'F5') { e.preventDefault(); void saveNow().then((ok) => flash(ok ? 'Saved' : 'Not saved')); return; }
    if (e.code === 'Tab') {
      e.preventDefault();
      if (state === 'craft') { setState('playing'); if (!player.dragLook) void requestLock().catch(() => flash('Click to resume mouse look.')); }
      else if (state === 'playing') { setState('craft'); if (document.pointerLockElement) document.exitPointerLock(); }
      return;
    }
    if (e.code === 'Escape') {
      if (state === 'craft') { setState('playing'); if (!player.dragLook) void requestLock().catch(() => flash('Click to resume mouse look.')); }
      else if (state === 'playing' && player.dragLook) setState('menu');
      return;
    }
    if (state !== 'playing' || e.repeat) return;
    if (e.code === 'KeyE') use();
    else if (e.code === 'KeyB') buildCampfire();
    else if (e.code === 'KeyT') { sky.speed = sky.speed === 1 ? 60 : 1; flash(sky.speed > 1 ? 'Fast time on (T)' : 'Fast time off'); }
    else {
      const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
      if (n >= 0 && !hotbar.select(SLOTS[n], (id) => inventory.counts[id] > 0)) flash(`Craft a ${SLOT_NAMES[SLOTS[n]].toLowerCase()} first (Tab).`);
    }
  });
  window.addEventListener('wheel', (e) => {
    if (state !== 'playing') return;
    const owned = SLOTS.filter((s) => s === 'hands' || inventory.counts[s] > 0);
    const i = owned.indexOf(hotbar.slot);
    hotbar.select(owned[(i + (e.deltaY > 0 ? 1 : -1) + owned.length) % owned.length], () => true);
  });

  if (import.meta.env.DEV) Object.assign(window, { __bc: { world, player, camera, saveNow, store, sky, survival, props, inventory, campfires, hotbar, fauna, flora, input, getState: () => state } });

  // --- HUD -----------------------------------------------------------------------------------------
  const deathEl = $('death'), frostEl = $('frost'), promptEl = $('prompt');
  const hpBar = document.querySelector('#hp > div') as HTMLElement, heatBar = document.querySelector('#heat > div') as HTMLElement;
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

  // --- Frame loop ----------------------------------------------------------------------------------
  const timer = new THREE.Timer();
  timer.connect(document);
  let fps = 0, frameMs = 0, uiTimer = 0, actionCooldown = 0;
  const floorY = MIN_CY * CHUNK - 8;
  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    const t0 = performance.now();
    const simulating = state === 'playing' || state === 'dead';

    world.update(player.position);
    player.frozen = !world.isReadyAt(player.position) || state === 'dead';
    if (simulating) {
      player.update(dt);
      physics.step();
      world.afterPhysics();
      if (player.position.y < floorY) player.teleport(spawnPoint); // fell out of the world

      sky.update(dt, camera);
      if (state === 'playing' && !player.frozen) {
        survival.update(dt, { eye: camera.position, sunDir: sky.sunDir, daylight: sky.daylight, meshes: world.meshes() });
        player.speedMul = survival.moveFactor();
        if (survival.dead) {
          setState('dead');
          deathEl.style.display = 'flex';
          setTimeout(() => {
            player.teleport(spawnPoint);
            survival.reset();
            deathEl.style.display = 'none';
            setState('playing');
          }, 3000);
        }
      }
      campfires.update(dt, player.position);
      flora.update(dt, camera.position, sky.night);
      fauna.update(dt, player.position, input.moving && input.down('run') && !player.crouching, player.crouching, sky.night);
      hotbar.update(dt, input.moving);

      // Held dig/fill (mouse or R/F): attacks a creature in reach, otherwise shapes the terrain.
      const dig = input.down('dig'), fill = input.down('fill');
      if ((dig || fill) && (actionCooldown -= dt) <= 0) {
        const prey = dig ? fauna.lookAt(camera, ATTACK[hotbar.slot].reach) : null;
        if (prey?.alive) { attack(prey); actionCooldown = 0.55; }
        else if (dig && hotbar.slot === 'spear') { hotbar.swing(); actionCooldown = 0.55; } // a jab at nothing
        else { brush(fill && !dig); hotbar.swing(); actionCooldown = DIG_POWER[hotbar.slot].interval; }
      } else if (!dig && !fill) actionCooldown = 0;
    } else {
      player.update(0); // keep the camera placed while paused
    }

    renderer.render(scene, camera);
    frameMs = frameMs * 0.95 + (performance.now() - t0) * 0.05;
    fps = fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

    // UI at 10 Hz: the look-at prompt, vitals and debug text.
    if ((uiTimer -= dt) <= 0) {
      uiTimer = 0.1;
      if (state === 'playing') { target = queryTarget(); promptEl.textContent = promptFor(target); }
      updateVitals();
      if (hud.style.display !== 'none') {
        const p = player.position;
        hud.textContent =
          `FPS ${fps.toFixed(0)}   frame ${frameMs.toFixed(1)} ms\n` +
          `chunks ${world.stats.loaded}  queued ${world.stats.queued}  mesh ${world.stats.meshMs.toFixed(1)} ms\n` +
          `tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k  draws ${renderer.info.render.calls}\n` +
          `pos ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}${player.frozen ? '  (loading ground…)' : ''}\n` +
          `time ${sky.clock()}${sky.speed > 1 ? ' (fast)' : ''}  edited chunks ${world.edits.size}  last save ${lastSaveMs.toFixed(1)} ms\n` +
          `seed ${seed}  ${state}${store.owner ? '' : '  (read-only tab)'}`;
      }
    }
  });
}

main().catch((err) => {
  console.error(err);
  hud.textContent = `Failed to start: ${(err as Error).message}`;
});
