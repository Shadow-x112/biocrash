// Biocrash: entry point. Builds the world and systems, runs the game-state machine and the frame loop.
import * as THREE from 'three';
import type RAPIERType from '@dimforge/rapier3d';
import { World } from './terrain/world';
import { createGenerator } from './terrain/density';
import { Input, K } from './input';
import { Player } from './player';
import { Sky } from './sky';
import { Survival, TEMP } from './survival';
import { Props } from './props';
import { Inventory, ITEM_NAMES, MATERIALS, GEAR, type ItemId } from './inventory';
import { RECIPES } from './crafting';
import { Hotbar, SLOTS, SLOT_NAMES, DIG_POWER, type Slot } from './tools';
import { Fauna, type Creature } from './creatures';
import { Flora } from './flora';
import { Campfires, CAMPFIRE_COST, FUEL_MAX, COOK_TIME } from './campfire';
import { Packs } from './packs';
import { Post, fxUniforms, addTerrainMist } from './fx';
import { Audio } from './audio';
import { Particles } from './particles';
import { Horror } from './horror';
import { SaveStore, type SaveMeta } from './save';
import { loadSettings, buildSettingsForm, buildKeysForm, type Settings } from './settings';
import { Tutorial, type MilestoneId } from './tutorial';
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
  const post = new Post(renderer, scene, camera);
  renderer.info.autoReset = false;
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    post.setSize(innerWidth, innerHeight);
  });
  // Wrist lamp: the AI core's emergency light. A narrow cone, no shadows, on a charge that refills at fires and in daylight.
  const lamp = new THREE.SpotLight(0xdff4ff, 0, 32, 0.42, 0.55, 1.2);
  lamp.position.set(0.15, -0.12, 0);
  lamp.target.position.set(0, -0.05, -1);
  camera.add(lamp, lamp.target);

  // --- Load the save ---------------------------------------------------------------------------
  const store = await SaveStore.open();
  const loaded = await store.load();
  const meta = loaded?.meta ?? null;
  const seed = meta?.seed ?? Math.random().toString(36).slice(2, 10);

  // --- World and systems -------------------------------------------------------------------------
  const physics = new RAPIER.World({ x: 0, y: -22, z: 0 });
  const world = new World(seed, RAPIER, physics);
  scene.add(world.group);
  addTerrainMist(world.material);
  if (loaded) for (const [k, v] of loaded.edits) world.edits.set(k, v);

  const input = new Input(canvas);
  const player = new Player(RAPIER, physics, camera, input);
  const audio = new Audio();
  const particles = new Particles(scene);
  const horror = new Horror(audio, scene);
  horror.load(meta?.horror);
  horror.onCaption = (text, pos) => caption(text, pos);
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
  if (meta?.vitals) { survival.health = meta.vitals.health; survival.warmth = meta.vitals.warmth; survival.fed = meta.vitals.fed ?? 0; survival.afterglow = meta.vitals.afterglow ?? 0; }
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
  const packs = new Packs();
  scene.add(packs.group);
  packs.load(meta?.packs);
  let wasNight = meta?.wasNight ?? false;
  let nights = meta?.nights ?? 0;
  const fauna = new Fauna((x, z) => world.groundAt(x, z));
  scene.add(fauna.group);

  // Render scale: the Resolution setting, lowered automatically (down to 50%) while the frame rate is poor.
  const basePR = Math.min(devicePixelRatio, 1.5);
  let resScale = 1;
  const applyRes = () => { renderer.setPixelRatio(basePR * resScale); post.setSize(innerWidth, innerHeight); };

  // --- Settings (per browser) and the station core's first-night objectives ------------------------
  const settings = loadSettings();
  const tutorial = new Tutorial($('core'), meta?.tutorialStep ?? 0, meta?.milestones);
  tutorial.goalMet = (id: MilestoneId) => {
    switch (id) {
      case 'raw_meat': return inventory.counts.cooked_meat > 0 || survival.fed > 0 || campfires.list.some((f) => f.cooking.length > 0);
      case 'cooked': return survival.fed > 0;
      case 'hide': return inventory.counts.hide_wrap > 0;
      case 'dawn': return player.position.distanceTo(spawnPoint) < 15;
      case 'death': return packs.list.length === 0;
      default: return false;
    }
  };
  tutorial.onLine = () => { if (audio.has('ui_2')) audio.play('ui_2', { bus: 'ui', gain: 0.35, rate: 1.3 }); };
  const compassEl = $('compass');
  // --- Captions: what the sound means and where it is, for sounds that carry the horror ------------
  const captionsEl = $('captions');
  let captionsOn = false;
  const dirOf = (p: THREE.Vector3) => {
    const f = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const to = p.clone().sub(camera.position).setY(0);
    if (to.lengthSq() < 4) return 'close';
    to.normalize();
    const ahead = f.dot(to), side = f.x * to.z - f.z * to.x; // >0: to the right
    return ahead > 0.7 ? 'ahead' : ahead < -0.7 ? 'behind' : side > 0 ? 'right' : 'left';
  };
  const caption = (text: string, pos?: THREE.Vector3) => {
    if (!captionsOn) return;
    const el = document.createElement('div');
    el.textContent = `[${text}${pos ? ', ' + dirOf(pos) : ''}]`;
    captionsEl.append(el);
    while (captionsEl.children.length > 3) captionsEl.firstElementChild!.remove();
    setTimeout(() => el.remove(), 4500);
  };
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
    player.shakeScale = settings.shakeAmt;
    input.toggles.clear();
    if (settings.runToggle) input.toggles.add('run');
    if (settings.sneakToggle) input.toggles.add('sneak');
    document.documentElement.style.setProperty('--ui', String(settings.uiScale));
    horror.intensity = settings.horrorAmt;
    horror.reduceFlash = settings.reduceFlash;
    post.reduceFlash = settings.reduceFlash;
    captionsOn = settings.captions;
    if (!captionsOn) captionsEl.innerHTML = '';
    compassEl.style.display = settings.compass ? '' : 'none';
    post.setEnabled(settings.post);
    // With post-processing on, its vignette and grain replace the CSS overlays.
    for (const id of ['unease', 'static']) $(id).style.display = settings.post ? 'none' : '';
    if (k === 'resolution' || k === 'autoRes' || k === 'master') { resScale = settings.resolution; applyRes(); }
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
    vitals: { health: survival.health, warmth: survival.warmth, fed: survival.fed, afterglow: survival.afterglow },
    milestones: [...tutorial.seen], packs: packs.save(), wasNight, nights, horror: horror.save(), lamp: lampCharge,
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
    if (s !== 'menu') overlay.classList.remove('showsettings', 'showlog');
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
  /** The key list on the pause screen and the crafting hint follow the player's bindings. */
  const renderKeyList = () => {
    $('keylist').textContent =
      `${K('forward')}${K('left')}${K('back')}${K('right')} move \u00b7 ${K('jump')} jump \u00b7 ${K('run')} run \u00b7 ${K('sneak')} sneak\n` +
      `${K('use')} pick up / use \u00b7 ${K('craft')} crafting \u00b7 1-4 tools\n` +
      `${K('build')} build campfire \u00b7 ${K('eat')} cook at a fire / eat \u00b7 ${K('lamp')} wrist lamp\n` +
      `${K('dig')} / left click dig \u00b7 ${K('fill')} / right click fill\n` +
      'Arrow keys also look around\nF3 debug info \u00b7 F5 save now \u00b7 Esc pause';
    $('craftsub').textContent = `Number keys or click to craft \u00b7 Shift+click makes up to 5 \u00b7 ${K('craft')} or Esc to close`;
  };
  renderKeyList();
  buildKeysForm($('keysform'), renderKeyList);
  $('opensettings').onclick = () => overlay.classList.add('showsettings');
  $('closesettings').onclick = () => overlay.classList.remove('showsettings');
  $('openlog').onclick = () => {
    const log = $('logtext');
    log.innerHTML = '';
    for (const line of tutorial.log()) { const p = document.createElement('p'); p.textContent = line; log.append(p); }
    overlay.classList.add('showlog');
  };
  $('closelog').onclick = () => overlay.classList.remove('showlog');
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
      const needs = (r.needs ?? []).map((k) => `<span class="${inventory.counts[k] > 0 ? 'ok' : 'no'}">needs ${ITEM_NAMES[k].toLowerCase()}</span>`).join(' · ');
      const name = ITEM_NAMES[r.makes];
      const have = inventory.counts[r.makes];
      const done = r.unique && have > 0;
      const can = !done && inventory.has(r.cost) && (r.needs ?? []).every((k) => inventory.counts[k] > 0);
      const btn = done ? '<span class="hint">made</span>' : `<button data-r="${r.id}"${can ? '' : ' class="off"'}>Craft</button>`;
      return `<div class="recipe"><div><div class="rname"><span class="key">${i + 1}</span>${name}${r.amount > 1 ? ' ×' + r.amount : ''}${have && !r.unique ? ` <span class="hint">(have ${have})</span>` : ''}</div>
        <div class="rcost">${costs}${needs ? ' · ' + needs : ''}</div><div class="rblurb">${r.blurb}</div></div>${btn}</div>`;
    }).join('');
  }
  const lastCounts: Partial<Record<ItemId, number>> = {};
  const popPrev: Partial<Record<ItemId, number>> = {};
  /** A small "+1 Fiber" that floats up from the crosshair. */
  const pop = (text: string) => {
    const el = document.createElement('div');
    el.className = 'pop';
    el.textContent = text;
    document.body.append(el);
    setTimeout(() => el.remove(), 1100);
  };
  inventory.onChange = () => {
    invEl.innerHTML = MATERIALS.filter((k, i) => i < 3 || inventory.counts[k] > 0).map((k) => {
      const got = (lastCounts[k] ?? inventory.counts[k]) < inventory.counts[k];
      lastCounts[k] = inventory.counts[k];
      return `<div class="row${got ? ' got' : ''}"><span>${ITEM_NAMES[k]}</span><span>${inventory.counts[k]}</span></div>`;
    }).join('') + GEAR.filter((k) => inventory.counts[k] > 0).map((k) => `<div class="row gear"><span>${ITEM_NAMES[k]}</span><span>${k === 'hide_wrap' ? 'worn' : k === 'chitin_spearhead' ? 'fitted' : '✓'}</span></div>`).join('');
    survival.wrapped = inventory.counts.hide_wrap > 0;
    if (inventory.counts.raw_meat > 0) tutorial.milestone('raw_meat');
    if (inventory.counts.hide > 0 && !inventory.counts.hide_wrap) tutorial.milestone('hide');
    requestAnimationFrame(() => invEl.querySelectorAll('.row.got').forEach((el) => el.classList.remove('got')));
    if (state === 'playing') for (const k of [...MATERIALS, ...GEAR]) {
      const d = inventory.counts[k] - (popPrev[k] ?? inventory.counts[k]);
      if (d > 0) pop(`+${d} ${ITEM_NAMES[k]}`);
    }
    for (const k of [...MATERIALS, ...GEAR]) popPrev[k] = inventory.counts[k];
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
    if (r.unique && inventory.counts[r.makes] > 0) { craftNote(`You already have a ${ITEM_NAMES[r.makes].toLowerCase()}.`); return; }
    const missing = (r.needs ?? []).filter((k) => inventory.counts[k] <= 0);
    if (missing.length) { audio.deny(); craftNote(`You need a ${missing.map((k) => ITEM_NAMES[k].toLowerCase()).join(' and a ')} for this.`); return; }
    if (r.unique) times = 1;
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
    | { kind: 'pack'; pk: NonNullable<ReturnType<Packs['near']>> }
    | null;
  let target: Target = null;
  const queryTarget = (): Target => {
    const c = fauna.lookAt(camera, ATTACK.spear.reach);
    if (c) return { kind: 'creature', c };
    const pk = packs.near(player.position, 2.5);
    if (pk) return { kind: 'pack', pk };
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
          : inventory.counts.stone_knife > 0 ? `${K('use')}  harvest ${t.c.species.name}` : `${t.c.species.name}  ·  needs a stone knife to harvest`;
      case 'prop': return `${K('use')}  pick up ${ITEM_NAMES[t.p.kind].toLowerCase()}`;
      case 'fire': {
        const cook = t.f.cooking.length ? `  \u00b7  cooking ${Math.ceil(t.f.cooking[0])}s${t.f.cooking.length > 1 ? ` (+${t.f.cooking.length - 1})` : ''}`
          : inventory.counts.raw_meat > 0 && t.f.lit ? `  \u00b7  ${K('eat')}  cook raw meat` : '';
        return (t.f.lit ? `${K('use')}  add stalkwood  \u00b7  burns ${fmtTime(t.f.fuel)}` : `${K('use')}  relight with stalkwood`) + cook;
      }
      case 'pack': return `${K('use')}  recover your pack (${Object.values(t.pk.items).reduce((a, b) => a + b, 0)} items)`;
      case 'stalk': {
        const left = flora.usesLeft(t.s);
        if (left <= 0) return 'Cut back';
        return inventory.counts.stone_knife + inventory.counts.stone_pick > 0 ? `${K('use')}  cut stalkwood  ·  ${left} left` : 'Stalkwood · needs a knife or pick';
      }
    }
  };

  // --- Actions -----------------------------------------------------------------------------------
  const aimDir = new THREE.Vector3();
  /** What terrain the crosshair is on, within `reach` (through the physics colliders, not the render meshes). */
  const aimAtTerrain = (reach: number) => world.raycast(camera.position, camera.getWorldDirection(aimDir), reach);
  const hitEl = $('hitmark'), crossEl = $('crosshair');
  /** Crosshair state: enemy in reach, something to use, a creature out of reach, terrain to dig, or nothing. */
  const crosshairFor = (t: Target): string => {
    const prey = fauna.lookAt(camera, ATTACK[hotbar.slot].reach);
    if (prey?.alive) return 'enemy';
    if (t && t.kind !== 'creature') return 'use';
    if (t?.kind === 'creature') return !t.c.alive && t.c.position.distanceTo(player.position) <= USE_REACH + 1 ? 'use' : 'far';
    return aimAtTerrain(REACH) ? 'dig' : 'none';
  };
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
    } else if (t.kind === 'pack') {
      const got: string[] = [];
      for (const [k, n] of Object.entries(t.pk.items)) if (k in inventory.counts && n > 0) { inventory.add(k as ItemId, n); got.push(`${n} ${ITEM_NAMES[k as ItemId].toLowerCase()}`); }
      packs.remove(t.pk);
      audio.pickup('fiber');
      flash(got.length ? `Recovered ${got.join(', ')}.` : 'The pack was empty.');
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
  // --- Wrist lamp ---------------------------------------------------------------------------------
  let lampOn = false, lampCharge = meta?.lamp ?? 100;
  const fireNearPlayer = () => {
    let n = 0;
    for (const f of campfires.list) if (f.lit) n = Math.max(n, 1 - f.position.distanceTo(player.position) / 12);
    return n;
  };
  /** Drains in about 4 minutes; refills by a fire (1 minute) or slowly in daylight. Flickers when low or when the core glitches. */
  const updateLamp = (dt: number, fireNear: number) => {
    if (lampOn) { lampCharge = Math.max(0, lampCharge - dt * (100 / 240)); if (lampCharge <= 0) { lampOn = false; flash('Lamp charge depleted.'); } }
    else lampCharge = Math.min(100, lampCharge + dt * (fireNear > 0.3 ? 100 / 60 : sky.daylight > 0.5 ? 100 / 300 : 0));
    let k = lampOn ? 1 : 0;
    if (lampOn && !settings.reduceFlash && (horror.glitch > 0 || (lampCharge < 15 && Math.random() < 0.08))) k = Math.random() < 0.5 ? 0.1 : 0.7;
    lamp.intensity = 18 * k * (lampCharge < 15 ? 0.6 : 1);
  };

  /** Q: cook raw meat on the fire you're looking at, otherwise eat cooked meat. */
  const food = () => {
    const f = campfires.lookAt(camera, USE_REACH);
    if (f && inventory.counts.raw_meat > 0) {
      if (!f.lit) { audio.deny(); flash(`Light the fire first: ${K('use')} with stalkwood.`); return; }
      if (f.cooking.length >= 4) { flash('The spit is full.'); return; }
      inventory.take({ raw_meat: 1 });
      f.cooking.push(COOK_TIME);
      audio.fireLit(f.position);
      flash(`Cooking. It takes ${COOK_TIME} seconds; keep the fire lit.`);
      return;
    }
    if (inventory.counts.cooked_meat > 0) {
      inventory.take({ cooked_meat: 1 });
      survival.fed = Math.min(TEMP.fedTime * 2, survival.fed + TEMP.fedTime);
      audio.pickup('fiber');
      flash(`Fed for ${fmtTime(survival.fed)}: you heal faster and hold your heat longer.`);
      return;
    }
    audio.deny();
    flash(inventory.counts.raw_meat > 0 ? `Cook raw meat first: look at a lit fire and press ${K('eat')}.` : 'Nothing to eat. Hunt, then cook the meat at a fire.');
  };
  campfires.onCooked = (f) => {
    inventory.add('cooked_meat');
    tutorial.milestone('cooked');
    if (f.position.distanceTo(player.position) < 12) { audio.pickup('fiber'); flash('Meat cooked.'); }
  };

  /** Station-core lines triggered by the world (the tutorial queues them and shows one at a time). */
  const milestones = () => {
    if (survival.warmth < 45 && sky.night > 0.3) tutorial.milestone('cold');
    if (tutorial.done && sky.time > 0.6 && sky.time < 0.7) tutorial.milestone('sunset');
    if (sky.night > 0.8) wasNight = true;
    if (wasNight && sky.time > 0.27 && sky.time < 0.4) { nights++; tutorial.milestone('dawn'); wasNight = false; }
    if (tutorial.seen.has('dawn') && player.position.distanceTo(spawnPoint) < 15) tutorial.milestone('wreck');
  };

  const buildCampfire = () => {
    const hit = aimAtTerrain(5);
    if (!hit || hit.normal.y < 0.6) { flash('Look at flat ground nearby to build a campfire.'); return; }
    if (!inventory.take(CAMPFIRE_COST)) {
      audio.deny();
      flash(`A campfire needs ${CAMPFIRE_COST.stalkwood} stalkwood and ${CAMPFIRE_COST.stone} stone.`);
      return;
    }
    campfires.add(hit.point.clone());
    audio.fireLit(hit.point);
    flash(`Campfire built. Add stalkwood (${K('use')}) to keep it burning.`);
  };
  /** Hits land when the swing connects (~0.12 s in), not when it starts. */
  const pendingHits: { t: number; c: Creature }[] = [];
  let hitStop = 0;
  const attack = (c: Creature) => {
    hotbar.swing();
    pendingHits.push({ t: 0.12, c });
  };
  const landHit = (c: Creature) => {
    if (!c.alive) return;
    const dmg = ATTACK[hotbar.slot].damage * (hotbar.slot === 'spear' && inventory.counts.chitin_spearhead > 0 ? 1.5 : 1);
    const hit = c.damage(dmg, player.position);
    const at = c.hitCentre();
    if (hit) {
      hitEl.className = c.alive ? 'on' : 'on kill';
      requestAnimationFrame(() => requestAnimationFrame(() => { hitEl.className = c.alive ? '' : 'kill'; }));
      audio.hit(at, !c.alive);
      if (!c.alive) { audio.play('meat_drop', { pos: at, gain: 0.8, delay: 0.15 }); tutorial.milestone('first_kill'); }
      particles.burst(at, c.alive ? 6 : 14, c.species.id === 'tuko' ? 0x6fd8c8 : 0xc9a27a, { speed: 3 });
      // Heavier hits feel heavier: shake and a brief freeze of the world (hit-stop) scale with damage.
      player.shake(Math.min(0.55, 0.08 + dmg / 70 + (c.alive ? 0 : 0.2)));
      hitStop = Math.min(0.09, 0.03 + dmg / 900 + (c.alive ? 0 : 0.03));
    } else if (c.state === 'curl') { audio.shellClack(at); particles.burst(at, 4, 0xffffff, { speed: 4, size: 0.03, life: 0.3 }); }
    if (!hit && c.state === 'curl') flash(`The ${c.species.name} curled into its shell.`);
    else if (!c.alive) flash(`${c.species.name} down. Harvest it with a stone knife (${K('use')}).`);
  };
  const brush = (fill: boolean) => {
    const aim = aimAtTerrain(REACH);
    if (!aim) return;
    const hit = { point: aim.point.clone(), normal: aim.normal.clone() }; // the ray result object is reused
    const power = DIG_POWER[hotbar.slot];
    const col = hit.normal.y < 0.6 ? 0x8a6d86 : 0x4f8a7a; // rock on slopes, moss on flat ground
    if (!fill) {
      world.brush(hit.point, power.radius, power.strength, -1);
      audio.dig(hit.point, hotbar.slot === 'stone_pick');
      particles.burst(hit.point, hotbar.slot === 'stone_pick' ? 12 : 8, col, { up: hit.normal.clone(), speed: 3 });
    } else {
      const p = hit.point.clone().addScaledVector(hit.normal, 0.6);
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
    if (input.is(e.code, 'craft')) {
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
    if (input.is(e.code, 'use')) use();
    else if (input.is(e.code, 'build')) buildCampfire();
    else if (input.is(e.code, 'eat')) food();
    else if (input.is(e.code, 'lamp')) {
      if (!lampOn && lampCharge < 3) { audio.deny(); flash('The lamp is out of charge. It refills by a fire or in daylight.'); }
      else { lampOn = !lampOn; audio.play('ui_2', { bus: 'ui', gain: 0.35, rate: lampOn ? 1.4 : 1.1 }); }
    }
    else if (e.code === 'KeyT') { sky.speed = sky.speed === 1 ? 60 : 1; flash(sky.speed > 1 ? 'Fast time on (T)' : 'Fast time off'); }
    else {
      const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
      if (n >= 0 && !hotbar.select(SLOTS[n], (id) => inventory.counts[id] > 0)) flash(`Craft a ${SLOT_NAMES[SLOTS[n]].toLowerCase()} first (${K('craft')}).`);
    }
  });
  window.addEventListener('wheel', (e) => {
    if (state !== 'playing') return;
    const owned = SLOTS.filter((s) => s === 'hands' || inventory.counts[s] > 0);
    const i = owned.indexOf(hotbar.slot);
    hotbar.select(owned[(i + (e.deltaY > 0 ? 1 : -1) + owned.length) % owned.length], () => true);
  });

  if (import.meta.env.DEV) Object.assign(window, { __bc: { world, player, camera, saveNow, store, sky, survival, props, inventory, campfires, hotbar, fauna, flora, input, audio, particles, horror, post, renderer, scene, getState: () => state, setNights: (n: number) => { nights = n; } } });

  // --- HUD -----------------------------------------------------------------------------------------
  const deathEl = $('death'), frostEl = $('frost'), promptEl = $('prompt');
  const hpBar = document.querySelector('#hp > div') as HTMLElement, heatBar = document.querySelector('#heat > div') as HTMLElement;
  const fahrenheit = navigator.language === 'en-US';
  const fmtTemp = (c: number) => (fahrenheit ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`);
  const buffsEl = $('buffs'), deathText = $('deathtext'), deathHint = $('deathhint');
  const updateVitals = () => {
    hpBar.style.width = `${survival.health}%`;
    heatBar.style.width = `${survival.warmth}%`;
    heatBar.style.backgroundColor = survival.warmth > 60 ? '#e0a050' : survival.warmth > 30 ? '#c9b98a' : '#8fc3e8';
    $('hpv').textContent = String(Math.ceil(survival.health));
    $('heatlabel').textContent = survival.cold ? '\u2744 Body heat \u00b7 freezing' : survival.warmth < 60 ? 'Body heat \u00b7 cooling' : 'Body heat';
    $('tempv').textContent = `air ${fmtTemp(survival.ambientC)}${survival.sheltered ? ' · sheltered' : survival.shaded ? ' · shade' : ''}`;
    frostEl.style.opacity = String(Math.max(0, (45 - survival.warmth) / 45));
    const buffs = [lampOn || lampCharge < 100 ? `Lamp ${Math.round(lampCharge)}%${lampOn ? '' : ` (${K('lamp')})`}` : '', survival.fed > 0 ? `Fed ${fmtTime(survival.fed)}` : '', survival.wrapped ? 'Hide wrap' : '', survival.afterglow > 0 ? `Recovering ${fmtTime(survival.afterglow)}` : ''].filter(Boolean).join('  \u00b7  ');
    if (buffsEl.textContent !== buffs) buffsEl.textContent = buffs;
    if (horror.glitch > 0) { // the wrist readout misbehaves for a moment
      $('tempv').textContent = `air ${fmtTemp(-60 + Math.random() * 140)}`;
      $('hpv').textContent = String(Math.floor(Math.random() * 999));
      $('heatlabel').textContent = Math.random() < 0.5 ? 'Body heat' : 'B\u0336ody h\u0336eat';
    }
  };

  // --- Sounds the world makes on its own: fires, creatures, your body when it's in trouble ---------
  let fireTimer = 0, callTimer = 1, bodyTimer = 0, lastCallCaption = 0;
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
        if (performance.now() - lastCallCaption > 10_000) { lastCallCaption = performance.now(); caption(c.species.id === 'tuko' ? 'Tuko chirping' : 'Oomi hooting', c.position); }
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
    + '<span class="mark" style="color:#e07a2f"></span><span class="mark" style="color:#ffb35c"></span><span class="mark" style="color:#f2f4f6"></span>';
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
    const packEl = tickEls[TICKS.length + 2], pk = packs.nearest(player.position);
    if (pk && pk.position.distanceTo(player.position) > 3) { packEl.textContent = `\u25C6 pack ${Math.round(pk.position.distanceTo(player.position))} m`; place(packEl, bearingTo(pk.position), heading); }
    else packEl.style.display = 'none';
  };

  // --- Frame loop ----------------------------------------------------------------------------------
  const timer = new THREE.Timer();
  timer.connect(document);
  let fps = 0, frameMs = 0, uiTimer = 0, actionCooldown = 0, resTimer = 4;
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
      physics.timestep = Math.max(1 / 240, dt); // dynamic bodies (M2) move at real speed on 60 or 144 Hz screens
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
          // Materials stay where you fell, in a pack on your compass. Tools and gear come with you.
          const items: Record<string, number> = {};
          for (const k of MATERIALS) if (inventory.counts[k] > 0) items[k] = inventory.counts[k];
          const dropped = Object.keys(items).length > 0;
          if (dropped) { packs.add(player.position.clone(), items); inventory.take(items as Partial<Record<ItemId, number>>); }
          deathText.textContent = 'You froze.';
          deathHint.textContent = dropped ? 'Your materials are where you fell, marked on the compass. Fire and shelter keep your core temperature up.'
            : 'Fire and shelter keep your core temperature up. Cooked meat and a hide wrap help you last the night.';
          deathEl.style.display = 'flex';
          setTimeout(() => {
            player.teleport(spawnPoint);
            survival.respawn();
            if (dropped) tutorial.milestone('death');
            deathEl.style.display = 'none';
            setState(player.dragLook || document.pointerLockElement === canvas ? 'playing' : 'menu');
          }, 3000);
        }
      }
      campfires.update(dt, player.position);
      packs.update(dt);
      flora.update(dt, camera.position, sky.night);
      const simDt = hitStop > 0 ? dt * 0.05 : dt;
      hitStop = Math.max(0, hitStop - dt);
      for (let k = pendingHits.length - 1; k >= 0; k--) if ((pendingHits[k].t -= dt) <= 0) { const h = pendingHits.splice(k, 1)[0]; landHit(h.c); }
      fauna.update(simDt, player.position, input.moving && input.down('run') && !player.crouching, player.crouching, sky.night);
      hotbar.update(simDt, input.moving);
      particles.update(simDt);
      updateLamp(dt, fireNearPlayer());
      worldSounds(dt);
      if (state === 'playing') {
        let fireNear = 0;
        for (const f of campfires.list) if (f.lit) fireNear = Math.max(fireNear, 1 - f.position.distanceTo(player.position) / 12);
        const g = world.groundAt(camera.position.x, camera.position.z);
        horror.update({ dt, camera, night: sky.night, daylight: sky.daylight, fireNear, warmth: survival.warmth, health: survival.health,
          underground: !!g && camera.position.y < g.y - 3, ground: (x, z) => world.groundAt(x, z), crashSite: spawnPoint,
          nights, running: input.moving && input.down('run') && !player.crouching, moving: input.moving,
          litFiresNear: campfires.list.filter((f) => f.lit && f.position.distanceToSquared(player.position) < 40 * 40).length,
          fogNear: (scene.fog as THREE.Fog).near });
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
      world.afterPhysics(); // nothing steps while paused, so retired colliders can go right away
    }

    tutorial.update(state === 'playing' ? dt : 0, inventory, campfires.list.length, horror.glitch);
    if (settings.compass) updateCompass();
    audio.updateListener(camera);
    audio.updateLoops();
    renderer.toneMappingExposure = horror.exposure;
    // Atmosphere uniforms: mist pools at night and with unease; mushrooms breathe at night.
    fxUniforms.uFxTime.value += dt;
    fxUniforms.uMist.value = Math.min(0.75, sky.night * 0.55 + horror.level * 0.3);
    fxUniforms.uMistTop.value = camera.position.y - 1.5;
    fxUniforms.uBreath.value = Math.min(1, sky.night * 0.6 + horror.level * 0.5);
    post.update(horror.level, horror.glitch, horror.staticT);
    const fog = scene.fog as THREE.Fog;
    fog.far = CHUNK * VIEW_RADIUS * (1 - sky.night * 0.4 - horror.level * 0.15);
    fog.near = fog.far * (0.55 - sky.night * 0.25);
    // Don't draw what the fog hides: the far plane follows the fog (at night ~70% of the loaded area is fogged out).
    const far = Math.min(CHUNK * (VIEW_RADIUS + 1), fog.far + CHUNK * 0.5);
    if (Math.abs(camera.far - far) > 2) { camera.far = far; camera.updateProjectionMatrix(); sky.setRadius(far * 0.9); }
    audio.updateAmbience(dt, sky.night, camera.position.y, camera.position);
    tm = performance.now();
    renderer.info.reset(); // count every pass of the frame for the F3 readout
    post.render(scene, camera, dt);
    smooth('render', performance.now() - tm);
    frameMs = frameMs * 0.95 + (performance.now() - t0) * 0.05;
    fps = fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

    if (settings.autoRes && state === 'playing' && (resTimer -= dt) <= 0) {
      resTimer = 2;
      const prev = resScale;
      if (fps < 48) resScale = Math.max(0.5, resScale - 0.1);
      else if (fps > 57) resScale = Math.min(settings.resolution, resScale + 0.05);
      if (resScale !== prev) applyRes();
    }

    // UI at 10 Hz: the look-at prompt, vitals and debug text.
    if ((uiTimer -= dt) <= 0) {
      uiTimer = 0.1;
      if (state === 'playing') {
        milestones();
        target = queryTarget(); promptEl.textContent = promptFor(target);
        const cls = crosshairFor(target);
        if (crossEl.className !== cls) crossEl.className = cls;
      }
      updateVitals();
      if (hud.style.display !== 'none') {
        const p = player.position;
        hud.textContent =
          `FPS ${fps.toFixed(0)}   frame ${frameMs.toFixed(1)} ms   res ${Math.round(resScale * 100)}%\n` +
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
