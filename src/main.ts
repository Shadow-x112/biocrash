// Biocrash: entry point. Builds the world and systems, runs the game-state machine and the frame loop.
import * as THREE from 'three';
import type RAPIERType from '@dimforge/rapier3d';
import { World } from './terrain/world';
import { createGenerator } from './terrain/density';
import { Input, K } from './input';
import { Player } from './player';
import { Sky, DAY_LENGTH } from './sky';
import { Survival, TEMP } from './survival';
import { Props } from './props';
import { Inventory, ITEM_NAMES, MATERIALS, GEAR, type ItemId } from './inventory';
import { RECIPES } from './crafting';
import { Hotbar, SLOTS, SLOT_NAMES, DIG_POWER, type Slot } from './tools';
import { Fauna, type Creature } from './creatures';
import { Wreck } from './wreck';
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
  // With post-processing on, its own multisampled buffer does the anti-aliasing; canvas AA would be paid for twice
  // (~150 MB at 1080p). Turning post off takes effect for AA on the next load.
  const renderer = new THREE.WebGLRenderer({ antialias: !loadSettings().post, stencil: false, powerPreference: 'high-performance' });
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
  // The held tool lives in its own little scene with its own camera (fixed 60° view, no fog), drawn over the world with
  // the depth cleared: it never clips into terrain and doesn't stretch with the FOV setting. Its lights mirror the world's.
  const hands = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 10) };
  const handHemi = new THREE.HemisphereLight(), handSun = new THREE.DirectionalLight(), handFire = new THREE.PointLight(0xff9a4a, 0, 6, 1.6);
  const handLamp = new THREE.PointLight(0xdff4ff, 0, 2, 1);
  handLamp.position.set(0.2, -0.1, -0.2);
  hands.scene.add(hands.camera, handHemi, handSun, handSun.target, handFire, handLamp);
  const post = new Post(renderer, scene, camera, hands);
  // Graphics quality. Low: no shadows, no MSAA. Medium: one 1024 sun/moon shadow (stalks, caps and creatures only cast).
  // High: a 2048 shadow. The shadow follows the player over +-25 m and is redrawn every third frame.
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  let shadowTick = 0;
  const applyQuality = () => {
    const q = settings.quality;
    renderer.shadowMap.enabled = q >= 1;
    sky.sun.castShadow = q >= 1;
    const size = q >= 2 ? 2048 : 1024;
    if (sky.sun.shadow.mapSize.x !== size) { sky.sun.shadow.mapSize.set(size, size); sky.sun.shadow.map?.dispose(); sky.sun.shadow.map = null; }
    const cam = sky.sun.shadow.camera;
    cam.left = cam.bottom = -25; cam.right = cam.top = 25; cam.near = 1; cam.far = 120; cam.updateProjectionMatrix();
    sky.sun.shadow.bias = -0.0004; sky.sun.shadow.normalBias = 0.04;
    post.setSamples(q >= 1 ? 4 : 0);
    // Shaders compiled while the shadow map didn't exist yet keep a stale shadow sampler, which ANGLE (Chrome on
    // Windows) rejects on every draw: the whole world vanished. Draw the shadow map now, then recompile once it exists.
    renderer.shadowMap.needsUpdate = true;
    recompileIn = 2;
  };
  let recompileIn = 0;
  const recompileAll = () => {
    for (const root of [scene, hands.scene]) root.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true;
    });
  };
  renderer.info.autoReset = false;
  window.addEventListener('resize', () => {
    camera.aspect = hands.camera.aspect = innerWidth / innerHeight;
    hands.camera.updateProjectionMatrix();
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
  { // Sound obstruction: one terrain ray from the listener to the sound (stopping short of the sound itself).
    const a = new THREE.Vector3(), d = new THREE.Vector3();
    audio.occluder = (from, to) => {
      a.set(from.x, from.y, from.z); d.set(to.x - from.x, to.y - from.y, to.z - from.z);
      const len = d.length();
      if (len < 4) return false;
      return world.raycast(a, d.divideScalar(len), len - 1.5) !== null;
    };
  }
  const particles = new Particles(scene);
  const horror = new Horror(audio, scene);
  horror.load(meta?.horror);
  horror.onCaption = (text, pos) => caption(text, pos);
  /** The lit fire you're sitting by (within 8 m), if any. */
  const campNear = () => {
    let best: THREE.Vector3 | null = null, bd = 8;
    for (const f of campfires.list) { const d = f.position.distanceTo(player.position); if (f.lit && d < bd) { bd = d; best = f.position; } }
    return best;
  };
  horror.onGutter = () => {
    let best: (typeof campfires.list)[number] | null = null, bd = 8;
    for (const f of campfires.list) { const d = f.position.distanceTo(player.position); if (f.lit && d < bd) { bd = d; best = f; } }
    best?.gutterNow(10 + Math.random() * 10);
  };
  // Rocky ground under foot when the terrain there is steep (mauve rock in the palette).
  // What's underfoot: caves and dug-out ground are soil, steep rock is gravel, the forest floor is moss.
  const surfaceUnderfoot = (): 'moss' | 'gravel' | 'soil' => {
    const g = world.groundAt(player.position.x, player.position.z);
    if (!g || player.position.y < g.y - 2) return 'soil';
    return g.ny < 0.8 ? 'gravel' : 'moss';
  };
  player.onStep = (run, sneak) => audio.footstep(run, sneak, surfaceUnderfoot());
  player.onJump = () => audio.jump();
  const hotbar = new Hotbar(hands.camera);
  player.onLand = (impact) => { audio.land(impact); hotbar.dip(Math.min(1, impact / 18)); };
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
  // The wreck of the station, beside the spawn point.
  const groundRay = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
  const wreck = new Wreck(RAPIER, physics, renderer, spawnPoint, (x, z) => {
    const hit = world.raycast(groundRay.set(x, spawnPoint.y + 40, z), down, 120);
    return hit ? hit.point.y : null;
  });
  scene.add(wreck.group);
  const props = new Props();
  props.blocked = (x, z) => wreck.covers(x, z);
  for (const id of meta?.picked ?? []) props.picked.add(id);
  scene.add(props.group);
  const flora = new Flora(RAPIER, physics, spawnPoint);
  flora.blocked = (x, z) => wreck.covers(x, z, 3);
  wreck.onSeated = () => { flora.clearBlocked(); props.clearBlocked(); };
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
    applyQuality();
    // With post-processing on, its vignette and grain replace the CSS overlays.
    for (const id of ['unease', 'static']) $(id).style.display = settings.post ? 'none' : '';
    if (k === 'resolution' || k === 'autoRes' || k === 'fov') { resScale = settings.resolution; applyRes(); } // 'fov' = the startup pass
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
  let resting = false; // resting by the fire (see rest())
  for (const k of ['master', 'fov'] as const) applySetting(k); // everything else is applied with these
  let lockWorked = false; // once mouse capture has worked, never fall back to drag-look
  const craftEl = $('craft');
  const setState = (s: GameState) => {
    state = s;
    if (s !== 'playing' && resting) { resting = false; $('rest').style.display = 'none'; }
    input.enabled = s === 'playing' && !resting;
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
  // Soft-lock escape: wedged in terrain, buried by a fill, or down a shaft you can't climb. Moves you to the surface
  // straight above, or to the nearest open ground; not to the wreck, so it's no free trip home. Once a minute.
  let lastUnstuck = -Infinity;
  $('unstuck').onclick = () => {
    if (performance.now() - lastUnstuck < 60_000) { flash('You just did that. Try again in a minute.'); return; }
    const p = player.position;
    let dest: THREE.Vector3 | null = null;
    const top = world.groundAt(p.x, p.z);
    if (top && top.y > p.y - 0.9 + 1.5) dest = new THREE.Vector3(p.x, top.y + 1.2, p.z); // underground: up to the surface
    for (let r = 2; !dest && r <= 10; r += 2)
      for (let a = 0; a < 8 && !dest; a++) {
        const x = p.x + Math.cos(a * Math.PI / 4) * r, z = p.z + Math.sin(a * Math.PI / 4) * r;
        const g = world.groundAt(x, z);
        if (g && g.ny > 0.7) dest = new THREE.Vector3(x, g.y + 1.2, z);
      }
    if (!dest) { flash('No open ground found nearby. Dig or fill your way out, or try again somewhere else.'); return; }
    lastUnstuck = performance.now();
    player.teleport(dest);
    flash('Moved you to open ground.');
  };
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
        await store.importFile(await f.text()); // validates fully, then blocks saving while it swaps the world
        clearInterval(autosave); // only once it worked: a rejected file must leave autosave running
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
      const warm = fireNearPlayer() > 0.5;
      const needs = [...(r.needs ?? []).map((k) => `<span class="${inventory.counts[k] > 0 ? 'ok' : 'no'}">needs ${ITEM_NAMES[k].toLowerCase()}</span>`),
        ...(r.heat ? [`<span class="${warm ? 'ok' : 'no'}">\u{1F525} needs a lit fire close by</span>`] : [])].join(' · ');
      const name = ITEM_NAMES[r.makes];
      const have = inventory.counts[r.makes];
      const done = r.unique && have > 0;
      const can = !done && inventory.has(r.cost) && (r.needs ?? []).every((k) => inventory.counts[k] > 0) && (!r.heat || warm);
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
    if (r.heat && fireNearPlayer() <= 0.5) { audio.deny(); craftNote('This needs a lit fire close by. Craft it at your camp.'); return; }
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
  const UP = new THREE.Vector3(0, 1, 0);
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
      t.c.strip();
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
      for (const [k, n] of Object.entries(t.pk.items)) if (Object.hasOwn(inventory.counts, k) && n > 0) { inventory.add(k as ItemId, n); got.push(`${n} ${ITEM_NAMES[k as ItemId].toLowerCase()}`); }
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
        if (flora.toppled(t.s)) { // the last cut: it comes down in a puff of spores
          particles.burst(t.s.base.clone().setY(t.s.base.y + 1), 26, 0x9fffe6, { speed: 3.5, life: 1.4 });
          audio.topple(t.s.base);
          player.shake(0.3);
          flash('The stalk comes down.');
        }
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
  /** Drains in 2.5 minutes, so trips away from the fire need planning; refills by a fire (1 minute) or slowly in daylight. Flickers when low or when the core glitches. */
  const updateLamp = (dt: number, fireNear: number) => {
    if (lampOn) { lampCharge = Math.max(0, lampCharge - dt * (100 / 150)); if (lampCharge <= 0) { lampOn = false; flash('Lamp charge depleted.'); } }
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
    if (sky.time > 0.6 && sky.time < 0.66) tutorial.milestone('sunset'); // urgent: shows even mid-tutorial
    if (sky.night > 0.8) wasNight = true;
    if (wasNight && sky.time > 0.27 && sky.time < 0.4) {
      nights++; tutorial.milestone('dawn'); wasNight = false;
      if (fireNearPlayer() > 0.5) audio.safeMotif(); // the reward cue: you kept the fire through the night
    }
    if (tutorial.seen.has('dawn') && player.position.distanceTo(spawnPoint) < 15) tutorial.milestone('wreck');
  };

  // --- Resting by the fire: the night passes ~6x faster, but the fire burns just as fast and the dark doesn't sleep ----
  const restEl = $('rest');
  const isNightTime = () => sky.time > 0.7 || sky.time < 0.25;
  const rest = () => {
    if (!isNightTime()) { flash('You can only rest through the night.'); return; }
    if (fireNearPlayer() < 0.58) { flash('Rest beside a lit fire.'); return; }
    if (!survival.sheltered) { flash('Rest with something over your head: dig in, or find an overhang by the fire.'); return; }
    resting = true;
    input.enabled = false; input.release();
    restEl.style.display = 'flex';
  };
  const wake = (why: string) => {
    if (!resting) return;
    resting = false;
    restEl.style.display = 'none';
    input.enabled = state === 'playing';
    flash(why);
  };
  canvas.addEventListener('mousedown', () => wake('You get up.'));

  /** The hand scene's lights follow the world's: sky colours, the sun or moon turned into the camera's frame, the
   *  nearest burning fire, and the lamp as a fill. */
  const camInv = new THREE.Quaternion(), tv = new THREE.Vector3();
  const syncHandLights = () => {
    camInv.copy(camera.quaternion).invert();
    handHemi.color.copy(sky.hemi.color); handHemi.groundColor.copy(sky.hemi.groundColor); handHemi.intensity = sky.hemi.intensity;
    handSun.color.copy(sky.sun.color); handSun.intensity = sky.sun.intensity;
    handSun.position.copy(tv.subVectors(sky.sun.position, sky.sun.target.position).normalize().applyQuaternion(camInv)).multiplyScalar(5);
    let near: THREE.Vector3 | null = null, nd = 14, str = 0;
    for (const f of campfires.list) { const d = f.position.distanceTo(camera.position); if (f.lit && d < nd) { nd = d; near = f.position; str = f.heat.heatC / 62; } }
    handFire.intensity = near ? 7 * str * Math.max(0, 1 - nd / 14) : 0;
    if (near) handFire.position.copy(tv.copy(near).setY(near.y + 0.9).sub(camera.position)).applyQuaternion(camInv).normalize().multiplyScalar(1.5);
    handLamp.intensity = lamp.intensity > 1 ? 0.6 : 0;
  };

  const MAX_FIRES = 40;
  /** Why a campfire can't go where you're aiming ('' if it can). */
  const placeProblem = (hit: { point: THREE.Vector3; normal: THREE.Vector3 } | null): string => {
    if (!hit || hit.normal.y < 0.6) return 'Look at flat ground nearby to build a campfire.';
    // Guards: not on top of another fire (spamming B stacked them), not inside your own feet, and a sane total.
    if (campfires.list.some((f) => f.position.distanceTo(hit.point) < 1.6)) return 'Too close to another fire.';
    if (hit.point.distanceTo(player.position.clone().setY(player.position.y - 0.9)) < 0.9) return 'Step back a little to build here.';
    // At the cap, the oldest cold fire pit is cleared to make room; if every fire is burning, refuse.
    if (campfires.list.length >= MAX_FIRES && !campfires.list.some((f) => !f.lit && f.cooking.length === 0)) return `You have ${MAX_FIRES} fires burning already.`;
    if (!inventory.has(CAMPFIRE_COST)) return `A campfire needs ${CAMPFIRE_COST.stalkwood} stalkwood and ${CAMPFIRE_COST.stone} stone.`;
    return '';
  };
  // Placement: the first press shows a see-through fire ring where it would go (green when it fits, red when not); a
  // second press, or a click, builds it. Anything else, or 8 seconds, cancels.
  const preview = campfires.makePreview();
  scene.add(preview.group);
  let placing = 0, digBlock = false;
  const cancelPlacing = () => { placing = 0; preview.group.visible = false; };
  const buildCampfire = () => {
    if (!placing) { placing = 8; return; }
    cancelPlacing();
    const hit = aimAtTerrain(5);
    const problem = placeProblem(hit);
    if (problem || !hit) { audio.deny(); flash(problem); return; }
    inventory.take(CAMPFIRE_COST);
    if (campfires.list.length >= MAX_FIRES) campfires.remove(campfires.list.find((f) => !f.lit && f.cooking.length === 0)!); // paid for: now clear the oldest cold pit
    campfires.add(hit.point.clone());
    audio.place(hit.point);
    flash(`Campfire built. Add stalkwood (${K('use')}) to keep it burning.`);
  };
  const updatePlacing = (dt: number) => {
    if (!placing) return;
    if ((placing -= dt) <= 0 || state !== 'playing') { cancelPlacing(); return; }
    const hit = aimAtTerrain(5);
    preview.group.visible = !!hit;
    if (hit) { preview.group.position.copy(hit.point); preview.setOk(!placeProblem(hit)); }
    promptEl.textContent = `${K('build')} or click: build here  \u00b7  ${placeProblem(hit) || 'fits'}`;
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
      audio.creatureCall(c.species.id, at, c.alive ? 'hurt' : 'death', c.voice, c.tint, 0.05);
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
    if (input.is(e.code, 'craft') && (state === 'playing' || state === 'craft')) { // Tab stays free for menu focus
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
    if (resting) { wake('You get up.'); return; }
    if (input.is(e.code, 'rest')) { rest(); return; }
    if (placing && !input.is(e.code, 'build')) cancelPlacing(); // any other action cancels placement
    if (input.is(e.code, 'use')) use();
    else if (input.is(e.code, 'build')) buildCampfire();
    else if (input.is(e.code, 'eat')) food();
    else if (input.is(e.code, 'lamp')) {
      if (!lampOn && lampCharge < 3) { audio.deny(); flash('The lamp is out of charge. It refills by a fire or in daylight.'); }
      else { lampOn = !lampOn; audio.play('ui_2', { bus: 'ui', gain: 0.35, rate: lampOn ? 1.4 : 1.1 }); }
    }
    else if (e.code === 'KeyT' && import.meta.env.DEV) { // fast time: a development aid only
      sky.speed = sky.speed === 1 ? 60 : 1; flash(sky.speed > 1 ? 'Fast time on (T)' : 'Fast time off'); }
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

  if (import.meta.env.DEV) Object.assign(window, { __bc: { wreck, world, player, camera, saveNow, store, sky, survival, props, inventory, campfires, hotbar, fauna, flora, input, audio, particles, horror, post, renderer, scene, getState: () => state, setNights: (n: number) => { nights = n; } } });

  // --- HUD -----------------------------------------------------------------------------------------
  const deathEl = $('death'), frostEl = $('frost'), promptEl = $('prompt');
  const hpBar = document.querySelector('#hp > div') as HTMLElement, heatBar = document.querySelector('#heat > div') as HTMLElement;
  const fahrenheit = navigator.language === 'en-US';
  const fmtTemp = (c: number) => (fahrenheit ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`);
  const goalEl = $('goal'), buffsEl = $('buffs'), deathText = $('deathtext'), deathHint = $('deathhint');
  const updateVitals = () => {
    hpBar.style.width = `${survival.health}%`;
    heatBar.style.width = `${survival.warmth}%`;
    heatBar.style.backgroundColor = survival.warmth > 60 ? '#e0a050' : survival.warmth > 30 ? '#c9b98a' : '#8fc3e8';
    $('hpv').textContent = String(Math.ceil(survival.health));
    $('heatlabel').textContent = survival.cold ? '\u2744 Body heat \u00b7 freezing' : survival.warmth < 60 ? 'Body heat \u00b7 cooling' : 'Body heat';
    $('tempv').textContent = `air ${fmtTemp(survival.ambientC)}${survival.sheltered ? ' · sheltered' : survival.shaded ? ' · shade' : ''}`;
    frostEl.style.opacity = String(Math.max(0, (45 - survival.warmth) / 45));
    const buffs = [lampOn || lampCharge < 100 ? `Lamp ${Math.round(lampCharge)}%${lampOn ? '' : ` (${K('lamp')})`}` : '', survival.fed > 0 ? `Fed ${fmtTime(survival.fed)}` : '', survival.wrapped ? 'Hide wrap' : '', survival.afterglow > 0 ? `Recovering ${fmtTime(survival.afterglow)}` : ''].filter(Boolean).join('  \u00b7  ');
    // The sky is the only other clock: a readout of time until dark, or until dawn.
    const until = (to: number) => fmtTime((((to - sky.time) % 1) + 1) % 1 * DAY_LENGTH);
    const clock = sky.time > 0.55 && sky.time < 0.75 ? `Dark in ${until(0.75)}` : isNightTime() ? `Dawn in ${until(0.27)}` : '';
    const line = [clock, buffs].filter(Boolean).join('  \u00b7  ');
    if (buffsEl.textContent !== line) buffsEl.textContent = line;
    const goal = tutorial.currentGoal();
    const goalText = goal ? `\u25B8 ${goal}` : '';
    if (goalEl.textContent !== goalText) goalEl.textContent = goalText;
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
    // Fright: the moment a creature bolts (or a tuko balls up) it gives an alarm call.
    for (const c of fauna.list) {
      if (c.state === c.heardState) continue;
      if ((c.state === 'flee' || c.state === 'curl') && c.heardState !== 'flee' && c.heardState !== 'curl' && c.position.distanceToSquared(player.position) < 40 * 40)
        audio.creatureCall(c.species.id, c.position, 'alarm', c.voice, c.tint);
      c.heardState = c.state;
    }
    if ((callTimer -= dt) <= 0) {
      callTimer = 1.5 + Math.random() * 3;
      const near = fauna.list.filter((c) => c.alive && c.position.distanceToSquared(player.position) < 30 * 30);
      const c = near[Math.floor(Math.random() * near.length)];
      if (c && c.state !== 'curl' && c.state !== 'sleep') {
        audio.creatureCall(c.species.id, c.position, 'idle', c.voice, c.tint);
        // Sometimes another of its kind answers, from somewhere else, a moment later.
        const other = near.find((o) => o !== c && o.species.id === c.species.id && o.state !== 'curl' && o.state !== 'sleep');
        if (other && Math.random() < 0.4) audio.creatureCall(other.species.id, other.position, 'idle', other.voice, other.tint, 1 + Math.random() * 2);
      } else if (c && c.species.id === 'oomi') audio.oomiHoot(c.position, true);
      if (c) {
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
  let fps = 0, frameMs = 0, uiTimer = 0, actionCooldown = 0, resTimer = 4, refreshEst = 30;
  // Per-section timings (ms, smoothed) for the F3 profiler.
  const prof = { world: 0, physics: 0, sim: 0, render: 0 };
  const smooth = (k: keyof typeof prof, v: number) => { prof[k] = prof[k] * 0.9 + v * 0.1; };
  const floorY = MIN_CY * CHUNK - 8;
  // An error inside a frame is retried a few times (it may be a one-off); if it keeps happening, the loop stops, the
  // world is saved, and the recovery screen appears instead of the game throwing every frame behind a frozen picture.
  let loopErrors = 0;
  renderer.setAnimationLoop(() => {
    try { frame(); loopErrors = 0; } catch (err) {
      if (++loopErrors < 5) { console.error(err); return; }
      renderer.setAnimationLoop(null);
      void saveNow().finally(() => showFatal(err, 'Biocrash hit an error', () => store.reset()));
    }
  });
  function frame() {
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

      const wdt = resting ? dt * 6 : dt; // world time while resting
      sky.update(wdt, camera);
      if (state === 'playing' && !player.frozen) {
        survival.update(wdt, { eye: camera.position, sunDir: sky.sunDir, daylight: sky.daylight, roof: (e) => !!world.raycast(e, UP, 40),
          ground: (x, z) => world.groundAt(x, z) });
        player.speedMul = survival.moveFactor();
        if (survival.dead) {
          setState('dead');
          audio.death();
          // Materials stay where you fell, in a pack on your compass. Tools and gear come with you, and so does a small
          // fire kit (2 stalkwood), so a night death can't chain into another one before you reach your pack.
          const items: Record<string, number> = {};
          for (const k of MATERIALS) {
            const keep = k === 'stalkwood' ? Math.min(2, inventory.counts[k]) : 0;
            if (inventory.counts[k] - keep > 0) items[k] = inventory.counts[k] - keep;
          }
          const dropped = Object.keys(items).length > 0;
          // On the ground at your feet (the body position is the capsule's centre, ~0.9 m up); underground, the cave floor.
          const feet = player.position.clone().setY(player.position.y - 0.9);
          const g = world.groundAt(feet.x, feet.z);
          if (g && Math.abs(g.y - feet.y) < 1.5) feet.y = g.y;
          if (dropped) { packs.add(feet, items); inventory.take(items as Partial<Record<ItemId, number>>); }
          deathText.textContent = 'You froze.';
          // Wake at the nearest fire you built that's still burning; with none, at the crash site.
          let wake: THREE.Vector3 = spawnPoint, best = Infinity;
          for (const f of campfires.list) {
            const d = f.position.distanceTo(player.position);
            if (f.lit && d < best) { best = d; wake = f.position.clone().add(new THREE.Vector3(1.6, 1.4, 0)); }
          }
          const atFire = wake !== spawnPoint;
          if (atFire) { const gw = world.groundAt(wake.x, wake.z); if (gw && Math.abs(gw.y - wake.y) < 4) wake.y = gw.y + 1.2; }
          deathHint.textContent = dropped ? `Your materials are where you fell, marked on the compass. You kept a fire kit. Waking ${atFire ? 'at your fire' : 'at the crash site'}\u2026`
            : 'Fire and shelter keep your core temperature up. Cooked meat and a hide wrap help you last the night.';
          deathEl.style.display = 'flex';
          setTimeout(() => {
            player.teleport(wake);
            survival.respawn();
            if (dropped) tutorial.milestone('death');
            deathEl.style.display = 'none';
            setState(player.dragLook || document.pointerLockElement === canvas ? 'playing' : 'menu');
          }, 3000);
        }
      }
      campfires.update(wdt, player.position);
      packs.update(dt);
      flora.update(wdt, camera.position, sky.night);
      wreck.update(wdt);
      const simDt = hitStop > 0 ? dt * 0.05 : dt;
      hitStop = Math.max(0, hitStop - dt);
      for (let k = pendingHits.length - 1; k >= 0; k--) if ((pendingHits[k].t -= dt) <= 0) { const h = pendingHits.splice(k, 1)[0]; landHit(h.c); }
      fauna.update(simDt, player.position, input.moving && input.down('run') && !player.crouching, player.crouching, sky.night);
      hotbar.update(simDt, input.moving, { yaw: player.yaw, pitch: player.pitch });
      particles.update(simDt);
      updateLamp(dt, fireNearPlayer());
      horror.lampDir = lampOn && lamp.intensity > 1 ? camera.getWorldDirection(new THREE.Vector3()) : null;
      worldSounds(dt);
      if (state === 'playing') {
        let fireNear = 0;
        for (const f of campfires.list) if (f.lit) fireNear = Math.max(fireNear, 1 - f.position.distanceTo(player.position) / 12);
        const g = world.groundAt(camera.position.x, camera.position.z);
        horror.update({ dt: wdt, camera, night: sky.night, daylight: sky.daylight, fireNear, warmth: survival.warmth, health: survival.health,
          underground: !!g && camera.position.y < g.y - 3, ground: (x, z) => world.groundAt(x, z), crashSite: spawnPoint,
          nights, running: input.moving && input.down('run') && !player.crouching, moving: input.moving,
          litFiresNear: campfires.list.filter((f) => f.lit && f.position.distanceToSquared(player.position) < 40 * 40).length,
          fogNear: (scene.fog as THREE.Fog).near, camp: campNear() });
        if (resting) {
          if (horror.phase === 'peak') wake('You jolt awake.');
          else if (fireNearPlayer() < 0.58) wake('The fire is dying. You wake.');
          else if (survival.warmth < 40) wake('You wake up cold.');
          else if (!isNightTime()) wake('Morning.');
        }
      }

      // Held dig/fill (mouse or R/F): attacks a creature in reach, otherwise shapes the terrain.
      const dig = input.down('dig'), fill = input.down('fill');
      updatePlacing(dt);
      if (!dig) digBlock = false;
      if (placing && dig && !digBlock) { buildCampfire(); digBlock = true; } // a click while placing builds instead of digging
      else if (digBlock) { /* that click was the build: no digging until it's released */ }
      else if ((dig || fill) && (actionCooldown -= dt) <= 0) {
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
    fxUniforms.uRim.value.setRGB(0.05 * sky.daylight, 0.04 * sky.daylight + 0.07 * sky.night, 0.03 * sky.daylight + 0.065 * sky.night);
    post.update(horror.level, horror.glitch, horror.staticT, sky.daylight, sky.night);
    const fog = scene.fog as THREE.Fog;
    fog.far = CHUNK * VIEW_RADIUS * (1 - sky.night * 0.4 - horror.level * 0.15);
    fog.near = fog.far * (0.55 - sky.night * 0.25);
    // Don't draw what the fog hides: the far plane follows the fog (at night ~70% of the loaded area is fogged out).
    const far = Math.min(CHUNK * (VIEW_RADIUS + 1), fog.far + CHUNK * 0.5);
    if (Math.abs(camera.far - far) > 2) { camera.far = far; camera.updateProjectionMatrix(); sky.setRadius(far * 0.9); }
    audio.updateAmbience(dt, sky.night, camera.position.y, camera.position);
    tm = performance.now();
    renderer.info.reset(); // count every pass of the frame for the F3 readout
    syncHandLights();
    if (renderer.shadowMap.enabled && ++shadowTick % 3 === 0) renderer.shadowMap.needsUpdate = true;
    post.render(scene, camera, dt, hands);
    if (recompileIn > 0 && --recompileIn === 0) recompileAll();
    smooth('render', performance.now() - tm);
    frameMs = frameMs * 0.95 + (performance.now() - t0) * 0.05;
    fps = fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

    if (settings.autoRes && state === 'playing' && (resTimer -= dt) <= 0) {
      resTimer = 2;
      const prev = resScale;
      // Judge against this screen's own refresh rate (the best rate seen recently), not a fixed 60: on a 30 Hz-capped
      // display a fixed "< 48 fps" rule dropped straight to 50% resolution and stayed there.
      refreshEst = Math.max(fps, refreshEst * 0.98);
      if (fps < refreshEst * 0.8) resScale = Math.max(0.5, resScale - 0.1);
      else if (fps > refreshEst * 0.95) resScale = Math.min(settings.resolution, resScale + 0.05);
      if (resScale !== prev) applyRes();
    }

    // UI at 10 Hz: the look-at prompt, vitals and debug text.
    if ((uiTimer -= dt) <= 0) {
      uiTimer = 0.1;
      if (state === 'playing') {
        milestones();
        target = queryTarget(); if (!placing) promptEl.textContent = promptFor(target);
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
  }
}

main().catch((err) => showFatal(err, 'Biocrash couldn\u2019t start'));

/** Never leave the player stuck: offer the raw save and a clean start, even if the game itself can't run. */
function showFatal(err: unknown, title: string, wipe: () => Promise<void> = () => SaveStore.wipe()) {
  console.error(err);
  if (document.getElementById('fatal')) return;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0d1014;color:#e8edf2;font:14px system-ui,sans-serif;z-index:10';
  box.id = 'fatal';
  box.innerHTML = `<div style="max-width:440px;padding:24px;background:#161b22;border-radius:10px"><h2 style="margin:0 0 8px"></h2>
    <p style="color:#b9c2cc"></p><button id="fx-export">Export raw save</button> <button id="fx-new">Start a new world</button></div>`;
  box.querySelector('h2')!.textContent = title;
  box.querySelector('p')!.textContent = (err as Error)?.message ?? String(err);
  if (document.pointerLockElement) document.exitPointerLock();
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
    try { await wipe(); location.reload(); }
    catch (er) { (e.target as HTMLButtonElement).textContent = (er as Error).message; }
  };
}
