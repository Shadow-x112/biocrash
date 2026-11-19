// Biocrash: entry point. Builds the world and systems, runs the game-state machine and the frame loop.
import * as THREE from 'three';
import type RAPIERType from '@dimforge/rapier3d';
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
import { Audio } from './audio';
import { Particles } from './particles';
import { Horror } from './horror';
import { SaveStore, type SaveMeta } from './save';
import { loadSettings, buildSettingsForm, type Settings } from './settings';
import { Tutorial } from './tutorial';
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
  // Physics is a separate ~3 MB WebAssembly file: load it while the page is already showing.
  hud.textContent = 'Loading physics…';
  const RAPIER: typeof RAPIERType = await import('@dimforge/rapier3d');
  hud.textContent = '';

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
  const audio = new Audio();
  const particles = new Particles(scene);
  const horror = new Horror(audio, scene);
  // Rocky ground under foot when the terrain there is steep (mauve rock in the palette).
  // What's underfoot: caves and dug-out ground are soil, steep rock is gravel, the forest floor is moss.
  const surfaceUnderfoot = (): 'moss' | 'gravel' | 'soil' => {
    const g = world.groundAt(player.position.x, player.position.z);
    if (!g || player.position.y < g.y - 2) return 'soil';
    return g.ny < 0.8 ? 'gravel' : 'moss';
  };
  player.onStep = (run, sneak) => audio.footstep(run, sneak, surfaceUnderfoot());
  player.onJump = () => audio.jump();
  player.onLand = (impact) => audio.land(impact);
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

  // --- Settings (per browser) and the station core's first-night objectives ------------------------
  const settings = loadSettings();
  const tutorial = new Tutorial($('core'), meta?.tutorialStep ?? 0);
  tutorial.onLine = () => { if (audio.has('ui_2')) audio.play('ui_2', { bus: 'ui', gain: 0.35, rate: 1.3 }); };
  const compassEl = $('compass');
  let uiBlip = 0;
  const applySetting = (k: keyof Settings) => {
    if (k === 'master' || k === 'sfx' || k === 'ambience' || k === 'ui') {
      Object.assign(audio.volumes, { master: settings.master, sfx: settings.sfx, ambience: settings.ambience, ui: settings.ui });
      audio.applyVolumes();
      audio.setWorldPaused(state !== 'playing' && state !== 'dead');
      if ((k === 'ui' || k === 'master') && performance.now() - uiBlip > 150 && audio.has('ui_1')) { uiBlip = performance.now(); audio.play('ui_1', { bus: 'ui', gain: 0.5 }); }
    }
    player.sensitivity = 0.0022 * settings.sensitivity;
    player.invertY = settings.invertY;
    player.baseFov = settings.fov;
    player.headBob = settings.headBob;
    player.shakeScale = settings.shake ? 1 : 0;
    compassEl.style.display = settings.compass ? '' : 'none';
    tutorial.enabled = settings.tutorial;
  };

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
  if (store.incompatible) {
    flash(`${store.incompatible.reason} Your old world is kept: Export it from the pause menu, or choose New world.`);
    $('status').textContent = store.incompatible.reason + ' This session is not saved.';
  } else if (!store.owner) {
    flash('This world is open in another tab. Changes here will not be saved.');
    for (const id of ['import', 'reset']) { const b = $<HTMLButtonElement>(id); b.disabled = true; b.title = 'Open in another tab: manage the world there.'; }
  }
  SaveStore.onVersionChange = () => { stopSaving(); flash('A newer Biocrash opened in another tab. This tab stopped saving: reload it.'); };

  // --- Saving --------------------------------------------------------------------------------------
  const currentMeta = (): SaveMeta => ({
    saveVersion: SAVE_VERSION, genVersion: GEN_VERSION, seed, savedAt: Date.now(), timeOfDay: sky.time,
    vitals: { health: survival.health, warmth: survival.warmth },
    inventory: { ...inventory.counts }, picked: [...props.picked], campfires: campfires.save(),
    stalks: Object.fromEntries(flora.harvested), tutorialStep: tutorial.step,
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
  // Hidden is the likely end of the session (mobile, tab switching): save, pause and stop the audio clock now.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      void saveNow();
      if (state === 'playing' || state === 'craft') setState('menu');
      audio.suspend();
    } else audio.resume();
  });
  const stopSaving = () => { store.suppressed = true; clearInterval(autosave); };

  // --- Game state ----------------------------------------------------------------------------------
  let state: GameState = 'menu';
  for (const k of ['master', 'fov'] as const) applySetting(k); // everything else is applied with these
  let lockWorked = false; // once mouse capture has worked, never fall back to drag-look
  const craftEl = $('craft');
  const setState = (s: GameState) => {
    state = s;
    input.enabled = s === 'playing';
    if (s !== 'playing') input.release();
    overlay.style.display = s === 'menu' ? 'flex' : 'none';
    if (s !== 'menu') overlay.classList.remove('showsettings');
    craftEl.style.display = s === 'craft' ? 'flex' : 'none';
    if (s === 'craft') { renderCraft(); audio.play('ui_1', { bus: 'ui', gain: 0.6 }); }
    if (s !== 'playing') $('prompt').textContent = '';
    audio.setWorldPaused(s !== 'playing' && s !== 'dead');
  };
  /** Captures the mouse. Resolves/rejects from the pointerlockchange/pointerlockerror events, because the Promise form
   *  of requestPointerLock() isn't available in every browser; unadjustedMovement (raw input) is Chromium-only. */
  const requestLock = () => new Promise<void>((resolve, reject) => {
    if (document.pointerLockElement === canvas) { resolve(); return; }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      document.removeEventListener('pointerlockchange', onChange);
      document.removeEventListener('pointerlockerror', onError);
      if (ok) resolve(); else reject(new Error('Mouse capture was refused'));
    };
    const onChange = () => { if (document.pointerLockElement === canvas) finish(true); };
    let retried = false;
    const plain = () => {
      retried = true;
      try { (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => finish(false)); } catch { finish(false); }
    };
    // With the Promise form, a refused raw-input option shows up as a rejection (and maybe an error event): retry plain.
    const onError = () => { if (retried || !usedPromise) finish(false); };
    const timer = setTimeout(() => finish(false), 1500);
    document.addEventListener('pointerlockchange', onChange);
    document.addEventListener('pointerlockerror', onError);
    let usedPromise = false;
    try {
      const r = canvas.requestPointerLock({ unadjustedMovement: true }) as unknown as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') { usedPromise = true; r.catch(() => { if (!settled && !retried) plain(); }); }
    } catch { plain(); }
  });
  const resume = async () => {
    audio.unlock();
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
    audio.unlock();
    if (state === 'playing' && !player.dragLook && document.pointerLockElement !== canvas) void requestLock().catch(() => {});
  });

  // --- Pause-menu buttons --------------------------------------------------------------------------
  buildSettingsForm($('settingsform'), settings, applySetting);
  $('opensettings').onclick = () => overlay.classList.add('showsettings');
  $('closesettings').onclick = () => overlay.classList.remove('showsettings');
  $('export').onclick = async () => {
    await saveNow();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(store.exportRaw() ?? store.exportFile(currentMeta(), world.edits));
    a.download = `biocrash-save-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    flash(store.incompatible ? 'Old world exported (unchanged)' : 'Save exported');
  };
  // The graphics driver can drop the WebGL context (driver reset, GPU switch). three.js restores it; pause meanwhile.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (state === 'playing' || state === 'craft') setState('menu');
    if (document.pointerLockElement) document.exitPointerLock();
    flash('Graphics were reset. Waiting for them to come back\u2026');
  });
  canvas.addEventListener('webglcontextrestored', () => flash('Graphics restored. Click to play.'));
  $('import').onclick = () => {
    if (!store.owner) { flash('This world is open in another tab. Import it there.'); return; }
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
    if (!store.owner) { flash('This world is open in another tab. Reset it there.'); return; }
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
  const invEl = $('inv'), recipesEl = $('recipes'), craftMsg = $('craftmsg');
  function renderHotbar() {
    $('hotbar').innerHTML = SLOTS.map((s, i) => {
      const owned = s === 'hands' || inventory.counts[s] > 0;
      const n = s === 'hands' ? 0 : inventory.counts[s];
      return `<div class="slot${s === hotbar.slot ? ' sel' : ''}${owned ? '' : ' locked'}"><b>${i + 1}${n > 1 ? ' · ×' + n : ''}</b>${SLOT_NAMES[s]}</div>`;
    }).join('');
  }
  function renderCraft() {
    $('craftinv').innerHTML = 'Carrying: ' + (MATERIALS.filter((k) => inventory.counts[k] > 0).map((k) => `<b>${inventory.counts[k]}</b> ${ITEM_NAMES[k].toLowerCase()}`).join(' · ') || 'nothing yet');
    recipesEl.innerHTML = RECIPES.map((r, i) => {
      const costs = (Object.keys(r.cost) as ItemId[]).map((k) => {
        const need = r.cost[k] ?? 0, have = inventory.counts[k];
        return `<span class="${have >= need ? 'ok' : 'no'}">${need} ${ITEM_NAMES[k].toLowerCase()}${have >= need ? '' : ` (${have})`}</span>`;
      }).join(' · ');
      const name = r.makes === 'campfire' ? 'Campfire' : ITEM_NAMES[r.makes];
      const have = r.makes === 'campfire' ? 0 : inventory.counts[r.makes];
      const btn = r.makes === 'campfire' ? '<span class="hint">press B in the world</span>'
        : `<button data-r="${r.id}"${inventory.has(r.cost) ? '' : ' class="off"'}>Craft</button>`;
      return `<div class="recipe"><div><div class="rname"><span class="key">${i + 1}</span>${name}${r.amount > 1 ? ' ×' + r.amount : ''}${have ? ` <span class="hint">(have ${have})</span>` : ''}</div>
        <div class="rcost">${costs}</div><div class="rblurb">${r.blurb}</div></div>${btn}</div>`;
    }).join('');
  }
  const lastCounts: Partial<Record<ItemId, number>> = {};
  inventory.onChange = () => {
    invEl.innerHTML = MATERIALS.filter((k, i) => i < 3 || inventory.counts[k] > 0).map((k) => {
      const got = (lastCounts[k] ?? inventory.counts[k]) < inventory.counts[k];
      lastCounts[k] = inventory.counts[k];
      return `<div class="row${got ? ' got' : ''}"><span>${ITEM_NAMES[k]}</span><span>${inventory.counts[k]}</span></div>`;
    }).join('');
    requestAnimationFrame(() => invEl.querySelectorAll('.row.got').forEach((el) => el.classList.remove('got')));
    renderHotbar();
    if (state === 'craft') renderCraft();
  };
  hotbar.onChange = renderHotbar;
  inventory.load(meta?.inventory);
  let craftMsgTimer = 0;
  const craftNote = (msg: string) => {
    craftMsg.textContent = msg;
    clearTimeout(craftMsgTimer);
    craftMsgTimer = window.setTimeout(() => { craftMsg.textContent = ''; }, 2500);
  };
  /** Crafts recipe `r` up to `times` times; reports what was made or what's missing. */
  const craft = (r: (typeof RECIPES)[number], times: number) => {
    if (r.makes === 'campfire') { craftNote('Build campfires in the world: close this, look at flat ground, press B.'); audio.deny(); return; }
    let made = 0;
    const first = inventory.counts[r.makes] === 0;
    while (made < times && inventory.take(r.cost)) { inventory.add(r.makes, r.amount); made++; }
    if (!made) {
      const short = (Object.keys(r.cost) as ItemId[]).filter((k) => inventory.counts[k] < (r.cost[k] ?? 0))
        .map((k) => `${(r.cost[k] ?? 0) - inventory.counts[k]} more ${ITEM_NAMES[k].toLowerCase()}`);
      audio.deny(); craftNote(`Need ${short.join(' and ')}.`); return;
    }
    if (audio.has('ui_3')) audio.playAny('ui', 6, { bus: 'ui', gain: 0.8 }); else audio.craft();
    const total = made * r.amount;
    craftNote(`Made ${ITEM_NAMES[r.makes].toLowerCase()}${total > 1 ? ' \u00d7' + total : ''}. You have ${inventory.counts[r.makes]}.`);
    if (r.tool && first) hotbar.select(r.makes as Slot, () => true); // equip your first one
  };
  recipesEl.addEventListener('click', (e) => {
    const r = RECIPES.find((x) => x.id === (e.target as HTMLElement).dataset.r);
    if (r) craft(r, (e as MouseEvent).shiftKey ? 5 : 1);
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
  const hitEl = $('hitmark'), crossEl = $('crosshair');
  /** Crosshair state: enemy in reach, something to use, a creature out of reach, terrain to dig, or nothing. */
  const crosshairFor = (t: Target): string => {
    const prey = fauna.lookAt(camera, ATTACK[hotbar.slot].reach);
    if (prey?.alive) return 'enemy';
    if (t && t.kind !== 'creature') return 'use';
    if (t?.kind === 'creature') return !t.c.alive && t.c.position.distanceTo(player.position) <= USE_REACH + 1 ? 'use' : 'far';
    digRay.setFromCamera(centre, camera);
    digRay.far = REACH;
    return digRay.intersectObjects(world.meshes(), false).length ? 'dig' : 'none';
  };
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
      if (audio.has('tear')) { audio.play('tear', { pos: t.c.position, offset: Math.random() * 9, dur: 1.4, gain: 0.9 }); audio.play('crunch', { pos: t.c.position, gain: 0.6, delay: 0.25 }); }
      else audio.chop(t.c.position);
      particles.burst(t.c.hitCentre(), 10, 0x7a3a3a, { speed: 2 });
      flash(`Harvested ${got.join(', ')}.`);
    } else if (t.kind === 'prop') {
      props.pick(t.p);
      audio.pickup(t.p.kind);
      inventory.add(t.p.kind, t.p.kind === 'fiber' && hotbar.slot === 'stone_knife' ? 2 : 1);
      hotbar.swing();
    } else if (t.kind === 'fire') {
      if (t.f.fuel >= FUEL_MAX - 1) flash('The fire is fully stoked.');
      else if (inventory.take({ stalkwood: 1 })) { campfires.addFuel(t.f); audio.fireLit(t.f.position); }
      else { audio.deny(); flash('You need stalkwood to feed the fire.'); }
    } else if (t.kind === 'stalk') {
      if (inventory.counts.stone_knife <= 0 && inventory.counts.stone_pick <= 0) { flash('Cut stalkwood with a stone knife or pick.'); return; }
      const got = flora.harvest(t.s);
      if (got) {
        inventory.add('stalkwood', got); hotbar.swing();
        audio.chop(t.s.base);
        particles.burst(t.s.base.clone().setY(t.s.base.y + 1.2), 8, 0xd9cfb8, { speed: 2.5 });
      } else flash('This stalk has been cut back as far as it goes.');
    }
  };
  const buildCampfire = () => {
    buildRay.setFromCamera(centre, camera);
    buildRay.far = 5;
    const hit = buildRay.intersectObjects(world.meshes(), false)[0];
    if (!hit?.face || hit.face.normal.y < 0.6) { flash('Look at flat ground nearby to build a campfire.'); return; }
    if (!inventory.take(CAMPFIRE_COST)) {
      audio.deny();
      flash(`A campfire needs ${CAMPFIRE_COST.stalkwood} stalkwood and ${CAMPFIRE_COST.stone} stone.`);
      return;
    }
    campfires.add(hit.point.clone());
    audio.fireLit(hit.point);
    flash('Campfire built. Add stalkwood (E) to keep it burning.');
  };
  const attack = (c: Creature) => {
    hotbar.swing();
    const hit = c.damage(ATTACK[hotbar.slot].damage, player.position);
    const at = c.hitCentre();
    if (hit) {
      hitEl.className = c.alive ? 'on' : 'on kill';
      requestAnimationFrame(() => requestAnimationFrame(() => { hitEl.className = c.alive ? '' : 'kill'; }));
      audio.hit(at, !c.alive);
      if (!c.alive) audio.play('meat_drop', { pos: at, gain: 0.8, delay: 0.15 });
      particles.burst(at, c.alive ? 6 : 14, c.species.id === 'tuko' ? 0x6fd8c8 : 0xc9a27a, { speed: 3 });
      player.shake(c.alive ? 0.25 : 0.45);
    } else if (c.state === 'curl') { audio.shellClack(at); particles.burst(at, 4, 0xffffff, { speed: 4, size: 0.03, life: 0.3 }); }
    if (!hit && c.state === 'curl') flash(`The ${c.species.name} curled into its shell.`);
    else if (!c.alive) flash(`${c.species.name} down. Harvest it with a stone knife (E).`);
  };
  const brush = (fill: boolean) => {
    digRay.setFromCamera(centre, camera);
    digRay.far = REACH;
    const hit = digRay.intersectObjects(world.meshes(), false)[0];
    if (!hit?.face) return;
    const power = DIG_POWER[hotbar.slot];
    const col = hit.face.normal.y < 0.6 ? 0x8a6d86 : 0x4f8a7a; // rock on slopes, moss on flat ground
    if (!fill) {
      world.brush(hit.point, power.radius, power.strength, -1);
      audio.dig(hit.point, hotbar.slot === 'stone_pick');
      particles.burst(hit.point, hotbar.slot === 'stone_pick' ? 12 : 8, col, { up: hit.face.normal, speed: 3 });
    } else {
      const p = hit.point.clone().addScaledVector(hit.face.normal, 0.6);
      if (p.distanceTo(player.position) < power.radius + 0.9) return; // don't bury yourself
      world.brush(p, power.radius, power.strength, +1);
      audio.fill(p);
      particles.burst(p, 5, col, { speed: 1.5, life: 0.5 });
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
      // Esc isn't a user gesture, so it can't recapture the mouse: go to the pause menu, whose button can.
      if (state === 'craft') setState(player.dragLook ? 'playing' : 'menu');
      else if (state === 'playing' && player.dragLook) setState('menu');
      return;
    }
    if (state === 'craft' && !e.repeat) {
      const n = Number(e.key);
      if (n >= 1 && n <= RECIPES.length) craft(RECIPES[n - 1], e.shiftKey ? 5 : 1);
      // Shift+digit gives a symbol in e.key on most layouts: fall back to the physical key.
      else if (e.shiftKey && /^Digit[1-9]$/.test(e.code)) { const d = Number(e.code.slice(5)); if (d <= RECIPES.length) craft(RECIPES[d - 1], 5); }
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

  if (import.meta.env.DEV) Object.assign(window, { __bc: { world, player, camera, saveNow, store, sky, survival, props, inventory, campfires, hotbar, fauna, flora, input, audio, particles, horror, getState: () => state } });

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
    if (horror.glitch > 0) { // the wrist readout misbehaves for a moment
      $('tempv').textContent = `air ${fmtTemp(-60 + Math.random() * 140)}`;
      $('hpv').textContent = String(Math.floor(Math.random() * 999));
      $('heatlabel').textContent = Math.random() < 0.5 ? 'Body heat' : 'B\u0336ody h\u0336eat';
    }
  };

  // --- Sounds the world makes on its own: fires, creatures, your body when it's in trouble ---------
  let fireTimer = 0, callTimer = 1, bodyTimer = 0;
  const hurtEl = $('hurt');
  const worldSounds = (dt: number) => {
    if ((fireTimer -= dt) <= 0) {
      fireTimer = 0.05 + Math.random() * 0.12;
      for (const f of campfires.list) {
        if (!f.lit || f.position.distanceToSquared(player.position) > 15 * 15 || Math.random() > 0.55) continue;
        audio.fireCrackle(f.position, Math.min(1, f.fuel / 180));
      }
    }
    if ((callTimer -= dt) <= 0) {
      callTimer = 1.5 + Math.random() * 3;
      const near = fauna.list.filter((c) => c.alive && c.position.distanceToSquared(player.position) < 30 * 30);
      const c = near[Math.floor(Math.random() * near.length)];
      if (c) {
        if (c.species.id === 'tuko' && c.state !== 'curl') audio.tukoChirp(c.position);
        else if (c.species.id === 'oomi') audio.oomiHoot(c.position, c.state === 'sleep');
      }
    }
    if (state === 'playing' && (bodyTimer -= dt) <= 0) {
      if (survival.health < 30) { audio.heartbeat(); bodyTimer = 0.6 + survival.health / 40; }
      else if (survival.cold) { audio.shiverBreath(); bodyTimer = 3 + Math.random() * 2; }
      else bodyTimer = 0.5;
    }
    const low = survival.health < 35 ? (35 - survival.health) / 35 : 0;
    hurtEl.style.opacity = low ? String(low * (0.7 + 0.3 * Math.sin(performance.now() / 180))) : '0';
  };

  // --- Compass: heading strip with the crash site and the nearest lit fire ------------------------
  // North is -Z (the way you face at yaw 0). 2 px per degree, ±90° visible.
  const TICKS: [number, string, boolean][] = [];
  for (let d = 0; d < 360; d += 15) {
    const card = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][d / 45];
    TICKS.push([d, d % 45 === 0 ? card : String(d), d % 45 !== 0]);
  }
  compassEl.innerHTML = TICKS.map(([, l, minor]) => `<span${minor ? ' class="minor"' : ''}>${l}</span>`).join('')
    + '<span class="mark" style="color:#e07a2f"></span><span class="mark" style="color:#ffb35c"></span>';
  const tickEls = [...compassEl.children] as HTMLElement[];
  const wrap = (a: number) => ((a % 360) + 540) % 360 - 180;
  const place = (el: HTMLElement, bearing: number, heading: number) => {
    const d = wrap(bearing - heading);
    if (Math.abs(d) > 88) { if (el.style.display !== 'none') el.style.display = 'none'; return; }
    el.style.display = '';
    el.style.left = `${180 + d * 2}px`;
  };
  const bearingTo = (p: THREE.Vector3) => Math.atan2(p.x - player.position.x, -(p.z - player.position.z)) * 180 / Math.PI;
  const updateCompass = () => {
    const jitter = horror.glitch > 0 ? (Math.random() - 0.5) * 60 : 0; // the readout drifts when the core glitches
    const heading = -player.yaw * 180 / Math.PI + jitter;
    TICKS.forEach(([d], i) => place(tickEls[i], d, heading));
    const wreck = tickEls[TICKS.length], fire = tickEls[TICKS.length + 1];
    const dw = player.position.distanceTo(spawnPoint);
    if (dw > 12) { wreck.textContent = `\u25BC wreck ${Math.round(dw)} m`; place(wreck, bearingTo(spawnPoint), heading); } else wreck.style.display = 'none';
    let best: THREE.Vector3 | null = null, bd = Infinity;
    for (const f of campfires.list) { const d = f.position.distanceTo(player.position); if (f.lit && d < bd) { bd = d; best = f.position; } }
    if (best && bd > 8) { fire.textContent = `\u25B2 fire ${Math.round(bd)} m`; place(fire, bearingTo(best), heading); } else fire.style.display = 'none';
  };

  // --- Frame loop ----------------------------------------------------------------------------------
  const timer = new THREE.Timer();
  timer.connect(document);
  let fps = 0, frameMs = 0, uiTimer = 0, actionCooldown = 0;
  // Per-section timings (ms, smoothed) for the F3 profiler.
  const prof = { world: 0, physics: 0, sim: 0, render: 0 };
  const smooth = (k: keyof typeof prof, v: number) => { prof[k] = prof[k] * 0.9 + v * 0.1; };
  const floorY = MIN_CY * CHUNK - 8;
  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    const t0 = performance.now();
    const simulating = state === 'playing' || state === 'dead';

    let tm = performance.now();
    world.update(player.position);
    smooth('world', performance.now() - tm);
    player.frozen = !world.isReadyAt(player.position) || state === 'dead';
    if (simulating) {
      tm = performance.now();
      player.update(dt);
      physics.step();
      world.afterPhysics();
      smooth('physics', performance.now() - tm);
      tm = performance.now();
      if (player.position.y < floorY) player.teleport(spawnPoint); // fell out of the world

      sky.update(dt, camera);
      if (state === 'playing' && !player.frozen) {
        survival.update(dt, { eye: camera.position, sunDir: sky.sunDir, daylight: sky.daylight, meshes: world.meshes() });
        player.speedMul = survival.moveFactor();
        if (survival.dead) {
          setState('dead');
          audio.death();
          deathEl.style.display = 'flex';
          setTimeout(() => {
            player.teleport(spawnPoint);
            survival.reset();
            deathEl.style.display = 'none';
            setState(player.dragLook || document.pointerLockElement === canvas ? 'playing' : 'menu');
          }, 3000);
        }
      }
      campfires.update(dt, player.position);
      flora.update(dt, camera.position, sky.night);
      fauna.update(dt, player.position, input.moving && input.down('run') && !player.crouching, player.crouching, sky.night);
      hotbar.update(dt, input.moving);
      particles.update(dt);
      worldSounds(dt);
      if (state === 'playing') {
        let fireNear = 0;
        for (const f of campfires.list) if (f.lit) fireNear = Math.max(fireNear, 1 - f.position.distanceTo(player.position) / 12);
        const g = world.groundAt(camera.position.x, camera.position.z);
        horror.update({ dt, camera, night: sky.night, daylight: sky.daylight, fireNear, warmth: survival.warmth, health: survival.health,
          underground: !!g && camera.position.y < g.y - 3, ground: (x, z) => world.groundAt(x, z), crashSite: spawnPoint });
      }

      // Held dig/fill (mouse or R/F): attacks a creature in reach, otherwise shapes the terrain.
      const dig = input.down('dig'), fill = input.down('fill');
      if ((dig || fill) && (actionCooldown -= dt) <= 0) {
        const prey = dig ? fauna.lookAt(camera, ATTACK[hotbar.slot].reach) : null;
        if (prey?.alive) { attack(prey); actionCooldown = 0.55; }
        else if (dig && hotbar.slot === 'spear') { hotbar.swing(); audio.swing(); actionCooldown = 0.55; } // a jab at nothing
        else { brush(fill && !dig); hotbar.swing(); actionCooldown = DIG_POWER[hotbar.slot].interval; }
      } else if (!dig && !fill) actionCooldown = 0;
      smooth('sim', performance.now() - tm);
    } else {
      player.update(0); // keep the camera placed while paused
    }

    tutorial.update(state === 'playing' ? dt : 0, inventory, campfires.list.length, horror.glitch);
    if (settings.compass) updateCompass();
    audio.updateListener(camera);
    audio.updateLoops();
    renderer.toneMappingExposure = horror.exposure;
    const fog = scene.fog as THREE.Fog;
    fog.far = CHUNK * VIEW_RADIUS * (1 - sky.night * 0.4 - horror.level * 0.15);
    fog.near = fog.far * (0.55 - sky.night * 0.25);
    audio.updateAmbience(dt, sky.night, camera.position.y, camera.position);
    tm = performance.now();
    renderer.render(scene, camera);
    smooth('render', performance.now() - tm);
    frameMs = frameMs * 0.95 + (performance.now() - t0) * 0.05;
    fps = fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

    // UI at 10 Hz: the look-at prompt, vitals and debug text.
    if ((uiTimer -= dt) <= 0) {
      uiTimer = 0.1;
      if (state === 'playing') {
        target = queryTarget(); promptEl.textContent = promptFor(target);
        const cls = crosshairFor(target);
        if (crossEl.className !== cls) crossEl.className = cls;
      }
      updateVitals();
      if (hud.style.display !== 'none') {
        const p = player.position;
        hud.textContent =
          `FPS ${fps.toFixed(0)}   frame ${frameMs.toFixed(1)} ms\n` +
          `chunks ${world.stats.loaded}  queued ${world.stats.queued}  mesh ${world.stats.meshMs.toFixed(1)} ms\n` +
          `tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k  draws ${renderer.info.render.calls}  geos ${renderer.info.memory.geometries}\n` +
          `ms  world ${prof.world.toFixed(2)}  physics ${prof.physics.toFixed(2)}  sim ${prof.sim.toFixed(2)}  render ${prof.render.toFixed(2)}\n` +
          `props ${props.count}  creatures ${fauna.list.length}  sounds ${audio.sampleCount}  unease ${horror.level.toFixed(2)}\n` +
          `pos ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}${player.frozen ? '  (loading ground…)' : ''}\n` +
          `time ${sky.clock()}${sky.speed > 1 ? ' (fast)' : ''}  edited chunks ${world.edits.size}  last save ${lastSaveMs.toFixed(1)} ms\n` +
          `seed ${seed}  ${state}${store.owner ? '' : '  (read-only tab)'}`;
      }
    }
  });
}

main().catch((err) => {
  console.error(err);
  // Safe start: never leave the player stuck. Offer the raw save and a clean start, even if the game itself can't run.
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0d1014;color:#e8edf2;font:14px system-ui,sans-serif;z-index:10';
  box.innerHTML = `<div style="max-width:440px;padding:24px;background:#161b22;border-radius:10px"><h2 style="margin:0 0 8px">Biocrash couldn\u2019t start</h2>
    <p style="color:#b9c2cc"></p><button id="fx-export">Export raw save</button> <button id="fx-new">Start a new world</button></div>`;
  box.querySelector('p')!.textContent = (err as Error).message;
  document.body.append(box);
  box.querySelector<HTMLButtonElement>('#fx-export')!.onclick = async () => {
    const blob = await SaveStore.dumpRaw();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `biocrash-raw-save-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  let armed = false;
  box.querySelector<HTMLButtonElement>('#fx-new')!.onclick = async (e) => {
    if (!armed) { armed = true; (e.target as HTMLButtonElement).textContent = 'Click again to delete the old world'; return; }
    await SaveStore.wipe();
    location.reload();
  };
});
