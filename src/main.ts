// Biocrash: entry point. Builds the world and systems, runs the game-state machine and the frame loop.
import * as THREE from 'three';
// HUD type: Rajdhani (labels, headings), Inter (small text), Share Tech Mono (the station core's voice). OFL, latin only.
import '@fontsource/rajdhani/latin-500.css';
import '@fontsource/rajdhani/latin-600.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/share-tech-mono/latin-400.css';
import type RAPIERType from '@dimforge/rapier3d';
import { World } from './terrain/world';
import { createGenerator } from './terrain/density';
import { Input, K } from './input';
import { Player } from './player';
import { Sky, DAY_LENGTH } from './sky';
import { Survival, TEMP } from './survival';
import { Props } from './props';
import { Inventory, ITEM_NAMES, MATERIALS, TOOLS, GEAR, SHELF_LIFE, STACK, PERISHABLE, type ItemId, type Perishable } from './inventory';
import { RECIPES, knows } from './crafting';
import { Hotbar, SLOTS, SLOT_NAMES, DIG_POWER, type Slot } from './tools';
import { Fauna, setCreatureModels, type Creature } from './creatures';
import { Wreck } from './wreck';
import { loadProps, propGlow, loadCreatures, loadViewmodels, loadFlora } from './assets';
import { Flora } from './flora';
import { Campfires, CAMPFIRE_COST, FUEL_MAX, FUEL_START, COOK_TIME } from './campfire';
import { Crates, MAX_CRATES, CRATE_SLOTS, type Crate } from './crate';
import { Placeables, MAX_SOLARS, FLARE_TIME } from './placeables';
import { Chips, CHIPS } from './chips';
import { Packs } from './packs';
import { Post, SkyEnv, fxUniforms, addTerrainSurface } from './fx';
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
  handLamp.position.set(0.24, -0.17, -0.38); // at the wrist lamp
  hands.scene.add(hands.camera, handHemi, handSun, handSun.target, handFire, handLamp);
  const post = new Post(renderer, scene, camera, hands);
  const skyEnv = new SkyEnv(renderer, scene);
  // Graphics quality. Low: no shadows, no MSAA. Medium: one 1024 sun/moon shadow (stalks, caps and creatures only cast).
  // High: a 2048 shadow. The shadow follows the player (+-30 m, +-40 m at High) and is redrawn every third frame.
  renderer.shadowMap.type = THREE.PCFShadowMap; // soft since r182 (PCFSoftShadowMap was removed in r186)
  renderer.shadowMap.autoUpdate = false;
  let shadowTick = 0;
  const applyQuality = () => {
    const q = settings.quality;
    renderer.shadowMap.enabled = q >= 1;
    sky.sun.castShadow = q >= 1;
    const size = q >= 2 ? 2048 : 1024;
    if (sky.sun.shadow.mapSize.x !== size) { sky.sun.shadow.mapSize.set(size, size); sky.sun.shadow.map?.dispose(); sky.sun.shadow.map = null; }
    const cam = sky.sun.shadow.camera;
    // Wider at High: tall caps 30 m away still cast (beyond the box, shadows simply stop).
    const R = q >= 2 ? 40 : 30;
    cam.left = cam.bottom = -R; cam.right = cam.top = R; cam.near = 1; cam.far = 140; cam.updateProjectionMatrix();
    sky.sun.shadow.bias = -0.0004; sky.sun.shadow.normalBias = 0.04;
    post.setQuality(q);
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
  // The wrist lamp: wide and strong (the nights here are black).
  const lamp = new THREE.SpotLight(0xdff4ff, 0, 42, 0.5, 0.6, 1.1);
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
  addTerrainSurface(world.material, renderer.capabilities.getMaxAnisotropy());
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
  const groundRay = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0), heatRay = new THREE.Vector3();
  const wreck = new Wreck(RAPIER, physics, renderer, spawnPoint, (x, z) => {
    const hit = world.raycast(groundRay.set(x, spawnPoint.y + 40, z), down, 120);
    return hit ? hit.point.y : null;
  }, meta?.wreck);
  scene.add(wreck.group, wreck.debris);
  const wreckPos = wreck; // (the compass code below has its own `wreck`)
  const props = new Props();
  props.blocked = (x, z) => wreck.covers(x, z) || wreck.debrisAt(x, z) || flora.trunkAt(x, z); // not inside the wreck or a mushroom trunk
  for (const id of meta?.picked ?? []) props.picked.add(id);
  scene.add(props.group);
  const flora = new Flora(RAPIER, physics, spawnPoint);
  flora.ground = (x, z) => world.groundAt(x, z)?.y ?? null;
  flora.blocked = (x, z) => wreck.covers(x, z, 3) || wreck.debrisAt(x, z, 0.3);
  wreck.onSeated = wreck.onDebris = () => { flora.clearBlocked(); props.clearBlocked(); };
  // The Blender-built props replace the placeholder shapes as soon as they load.
  void loadProps().then((m) => { props.setLooks(m); flora.setLooks(m); campfires.setLooks(m); packs.setLook(m.Pack); });
  void loadViewmodels().then((m) => hotbar.setLooks(m));
  void loadFlora().then((m) => flora.setFungus(m.Fungus));
  void loadCreatures().then((m) => { setCreatureModels(m); if (m?.figure) horror.setFigure(m.figure); });
  for (const [k, v] of Object.entries(meta?.stalks ?? {})) flora.harvested.set(k, v);
  scene.add(flora.group);
  world.onChunkMesh = (key, _mesh, deco) => { flora.onChunkMesh(key, deco); props.onChunkMesh(key, deco); }; // trunks first: props avoid them
  world.onChunkUnload = (key) => { props.onChunkUnload(key); flora.onChunkUnload(key); };
  const inventory = new Inventory();
  const campfires = new Campfires(survival.heatSources);
  scene.add(campfires.group);
  campfires.load(meta?.campfires);
  campfires.setPhysics(RAPIER, physics);
  const packs = new Packs();
  scene.add(packs.group);
  packs.load(meta?.packs);
  const crates = new Crates(RAPIER, physics);
  scene.add(crates.group);
  crates.load(meta?.crates);
  const cratePreview = crates.makePreview();
  scene.add(cratePreview.group);
  /** The crate whose contents the crafting panel is showing (null: the panel shows recipes). */
  let storeCrate: Crate | null = null;
  /** Creatures scanned with the wrist link. Saves from before scanning existed keep the recipes they had. */
  const scanned = new Set<string>(meta?.scanned ?? (meta?.inventory ? ['tuko', 'oomi'] : []));
  // Station tech placed in the world (flares, solar panels) and the data chips around the wreck.
  const placeables = new Placeables(RAPIER, physics);
  scene.add(placeables.group);
  placeables.load(meta?.placed);
  // Mushrooms don't grow (or sprout) through what you've built: a sprout could come up inside a fire, crate or panel.
  const wreckBlocked = flora.blocked;
  flora.blocked = (x, z) => !!wreckBlocked?.(x, z)
    || campfires.list.some((f) => Math.hypot(f.position.x - x, f.position.z - z) < 0.9)
    || crates.list.some((c) => Math.hypot(c.position.x - x, c.position.z - z) < 0.9)
    || placeables.solars.some((p) => Math.hypot(p.pos.x - x, p.pos.z - z) < 1.0);
  const flarePreview = placeables.makePreview('flare'), solarPreview = placeables.makePreview('solar');
  scene.add(flarePreview.group, solarPreview.group);
  const chips = new Chips(spawnPoint, (id) => scanned.has(id), wreck);
  scene.add(chips.group);
  void loadProps().then((m) => { placeables.setLooks(m); flarePreview.refresh(); solarPreview.refresh(); chips.setLook(m.Chip); });
  void loadProps().then((m) => { crates.setLooks(m); cratePreview.refresh(); });
  let wasNight = meta?.wasNight ?? false;
  let nights = meta?.nights ?? 0;
  const fauna = new Fauna((x, z) => world.groundAt(x, z));
  fauna.blocked = (x, z, r) => flora.trunkAt(x, z, r) || wreck.covers(x, z, r * 0.5)
    || crates.list.some((c) => Math.hypot(c.position.x - x, c.position.z - z) < 0.6 + r)
    || campfires.list.some((f) => Math.hypot(f.position.x - x, f.position.z - z) < 0.9 + r);
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
      case 'raw_meat': return inventory.counts.cooked_meat > 0 || survival.fed > 0 || campfires.list.some((f) => f.cooking.length > 0 || f.ready.length > 0);
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
    document.documentElement.style.setProperty('--cap', String(settings.captionSize));
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
  let respawnTo: THREE.Vector3 | null = null, loadCheck = true;
  const currentMeta = (): SaveMeta => ({
    saveVersion: SAVE_VERSION, genVersion: GEN_VERSION, seed, savedAt: Date.now(), timeOfDay: sky.time,
    // Saved on the death screen: store where and how you wake (it stored 0 health, clamped to 1, at the spot you froze,
    // so the reload froze you again at once).
    vitals: respawnTo ? { health: 50, warmth: 60, fed: 0, afterglow: 120 } : { health: survival.health, warmth: survival.warmth, fed: survival.fed, afterglow: survival.afterglow },
    milestones: [...tutorial.seen], packs: packs.save(), wasNight, nights, horror: horror.save(), lamp: lampCharge,
    crates: crates.save(), placed: placeables.save(), wear: { ...inventory.wear } as Record<string, number>, scanned: [...scanned], inventory: { ...inventory.counts }, fresh: { raw_meat: [...inventory.ages.raw_meat], cooked_meat: [...inventory.ages.cooked_meat] }, seen: [...inventory.seen], picked: [...props.picked], campfires: campfires.save(), wreck: wreck.save(),
    stalks: Object.fromEntries(flora.harvested), tutorialStep: tutorial.step,
    player: respawnTo ? { x: respawnTo.x, y: respawnTo.y, z: respawnTo.z, yaw: player.yaw, pitch: 0 } : { x: player.position.x, y: player.position.y, z: player.position.z, yaw: player.yaw, pitch: player.pitch },
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
    canvas.classList.toggle('soft', s === 'craft'); // the world blurs a little behind the panel (it keeps running)
    if (s !== 'craft') storeCrate = null;
    $('craftview').hidden = !!storeCrate; $('storeview').hidden = !storeCrate;
    if (s === 'craft') { if (storeCrate) renderStore(); else renderCraft(); audio.play('ui_1', { bus: 'ui', gain: 0.6 }); }
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
      `${K('build')} build campfire \u00b7 ${K('eat')} cook at a fire / eat \u00b7 ${K('lamp')} wrist lamp \u00b7 hold ${K('scan')} scan a creature\n` +
      `${K('dig')} / left click dig \u00b7 ${K('fill')} / right click fill\n` +
      'Arrow keys also look around\nF1 hide the HUD \u00b7 F3 debug info \u00b7 F5 save now \u00b7 Esc pause';
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
  /** Somewhere to stand near `p`: the surface straight above if you're under it (when `up`), else the nearest open,
   *  walkable ground within 10 m. Never inside a mushroom trunk, the wreck, a crate or a fire (it could put you right
   *  back into what you were stuck in). */
  const openGround = (p: THREE.Vector3, up: boolean): THREE.Vector3 | null => {
    const free = (x: number, z: number) => !(fauna.blocked?.(x, z, 0.45));
    const top = world.groundAt(p.x, p.z);
    if (up && top && top.y > p.y - 0.9 + 1.5 && free(p.x, p.z)) return new THREE.Vector3(p.x, top.y + 1.2, p.z); // underground: up to the surface
    for (let r = 2; r <= 10; r += 1)
      for (let a = 0; a < 12; a++) {
        const x = p.x + Math.cos(a * Math.PI / 6) * r, z = p.z + Math.sin(a * Math.PI / 6) * r;
        const g = world.groundAt(x, z);
        if (g && g.ny > 0.7 && free(x, z)) return new THREE.Vector3(x, g.y + 1.2, z);
      }
    return null;
  };
  $('unstuck').onclick = () => {
    if (performance.now() - lastUnstuck < 60_000) { flash('You just did that. Try again in a minute.'); return; }
    const dest = openGround(player.position, true);
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
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000); // revoking at once cancels the download in Firefox and Safari
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
  let invShowT = 0; // seconds the inventory list stays up after a change
  let craftableOnly = false;
  let recipeCheck: (() => void) | null = null; // set once the save is loaded, so loading doesn't announce recipes
  /** Pixel icon for an item, tool or the bare-hands slot (public/icons). */
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const ico = (id: string) => `<img class="ico" src="icons/${id}.png" alt="">`;
  function renderHotbar() {
    $('hotbar').innerHTML = SLOTS.map((s, i) => {
      const owned = s === 'hands' || inventory.counts[s] > 0;
      const n = s === 'hands' ? 0 : inventory.counts[s];
      const c = s === 'hands' ? null : inventory.condition(s);
      const dur = c === null ? '' : `<i class="dur${c < 0.25 ? ' low' : ''}"><i style="transform:scaleX(${c.toFixed(2)})"></i></i>`;
      return `<div class="slot${s === hotbar.slot ? ' sel' : ''}${owned ? '' : ' locked'}">${ico(s)}<b>${i + 1}${n > 1 ? ' · ×' + n : ''}</b>${SLOT_NAMES[s]}${dur}</div>`;
    }).join('');
  }
  function renderCraft() {
    const ld = inventory.load_();
    $('craftinv').innerHTML = `<span class="load ${ld.name.toLowerCase()}">${inventory.usedSlots()}/${inventory.slots()} slots \u00b7 ${inventory.weight().toFixed(1)} kg \u00b7 ${ld.name}</span> \u00b7 Carrying: ` + (MATERIALS.filter((k) => inventory.counts[k] > 0).map((k) => `${ico(k)}<b>${inventory.counts[k]}</b> ${ITEM_NAMES[k].toLowerCase()}`).join(' · ') || 'nothing yet');
    $('craftfilter').textContent = craftableOnly ? 'Craftable (F)' : 'All (F)';
    $('craftfilter').classList.toggle('on', craftableOnly);
    recipesEl.innerHTML = RECIPES.map((r, i) => {
      if (!known.has(r.id)) {
        if (craftableOnly) return '';
        const parts = [...Object.keys(r.cost), ...(r.needs ?? [])] as ItemId[];
        const found = parts.filter((k) => inventory.seen.has(k)).length;
        // A missing part you make rather than find (the bone needle) is named: "pick up" would send you hunting for it.
        const make = parts.filter((k) => !inventory.seen.has(k) && RECIPES.some((x) => x.makes === k)).map((k) => ITEM_NAMES[k].toLowerCase());
        const how = r.scan?.startsWith('chip') ? 'Station tech: find a data chip near the wreck and read it' : r.scan ? `Scan a ${r.scan === 'tuko' ? 'Tuko' : 'Oomi'} with the wrist link (hold ${K('scan')}) to work it out` : `Pick up its materials to work it out \u00b7 ${found}/${parts.length} found${make.length ? ` \u00b7 make a ${make.join(' and a ')} first` : ''}`;
        return `<div class="recipe unknown"><div><div class="rname"><span class="key">${i + 1}</span><span class="ico q">?</span>Unknown recipe</div>
          <div class="rblurb">${how}</div></div><span class="hint">locked</span></div>`;
      }
      const costs = (Object.keys(r.cost) as ItemId[]).map((k) => {
        const need = r.cost[k] ?? 0, have = inventory.counts[k];
        return `<span class="${have >= need ? 'ok' : 'no'}">${have >= need ? '\u2713' : '\u2717'} ${ico(k)}${ITEM_NAMES[k]} <b>${Math.min(have, 999)}/${need}</b></span>`;
      }).join(' · ');
      const warm = fireNearPlayer() > 0.5;
      const needs = [...(r.needs ?? []).map((k) => `<span class="${inventory.counts[k] > 0 ? 'ok' : 'no'}">${inventory.counts[k] > 0 ? '\u2713' : '\u2717'} ${ico(k)}needs ${ITEM_NAMES[k].toLowerCase()}</span>`),
        ...(r.heat ? [`<span class="${warm ? 'ok' : 'no'}">${warm ? '\u2713' : '\u2717'} \u{1F525} needs a lit fire close by</span>`] : [])].join(' · ');
      const name = ITEM_NAMES[r.makes];
      const have = inventory.counts[r.makes];
      const done = r.unique && have > 0;
      const can = !done && inventory.has(r.cost) && (r.needs ?? []).every((k) => inventory.counts[k] > 0) && (!r.heat || warm);
      const btn = done ? '<span class="hint">made</span>' : `<button data-r="${r.id}"${can ? '' : ' class="off"'}>${r.place ? 'Place' : 'Craft'}</button>`;
      if (craftableOnly && !can) return '';
      return `<div class="recipe${done ? ' done' : ''}"><div><div class="rname"><span class="key">${i + 1}</span>${ico(r.makes)}${name}${r.amount > 1 ? ' ×' + r.amount : ''}${have && !r.unique ? ` <span class="hint">(have ${have})</span>` : ''}</div>
        ${done ? '' : `<div class="rcost">${costs}${needs ? ' · ' + needs : ''}</div>`}<div class="rblurb">${r.blurb}</div></div>${btn}</div>`;
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
    invShowT = 5;
    const ld = inventory.load_(), used = inventory.usedSlots(), cap = inventory.slots();
    invEl.innerHTML = `<div class="row head ${ld.name.toLowerCase()}${used >= cap ? ' full' : ''}"><span title="carry slots">\u25A6 ${used}/${cap}</span><span title="${ld.name}">${inventory.weight().toFixed(1)} kg</span></div>`
      + MATERIALS.filter((k, i) => i < 3 || inventory.counts[k] > 0).map((k) => {
      const got = (lastCounts[k] ?? inventory.counts[k]) < inventory.counts[k];
      lastCounts[k] = inventory.counts[k];
      const f = PERISHABLE.includes(k as Perishable) ? inventory.freshness(k as Perishable) : null;
      const stale = f !== null && f < (SHELF_LIFE[k] ?? 0) * 0.25;
      return `<div class="row${got ? ' got' : ''}${stale ? ' stale' : ''}"${stale ? ` title="spoils in ${fmtTime(f!)}"` : ''}><span>${ico(k)}${ITEM_NAMES[k]}</span><span>${inventory.counts[k]}</span></div>`;
    }).join('') + GEAR.filter((k) => inventory.counts[k] > 0).map((k) => `<div class="row gear"><span>${ico(k)}${ITEM_NAMES[k]}</span><span>${k === 'hide_wrap' ? 'worn' : k === 'chitin_spearhead' ? 'fitted' : '✓'}</span></div>`).join('');
    survival.wrapped = inventory.counts.hide_wrap > 0;
    if (inventory.counts.raw_meat > 0) tutorial.milestone('raw_meat');
    if (inventory.counts.hide > 0 && !inventory.counts.hide_wrap) tutorial.milestone('hide');
    requestAnimationFrame(() => invEl.querySelectorAll('.row.got').forEach((el) => el.classList.remove('got')));
    if (state === 'playing') for (const k of [...MATERIALS, ...GEAR]) {
      const d = inventory.counts[k] - (popPrev[k] ?? inventory.counts[k]);
      if (d > 0) pop(`+${d} ${ITEM_NAMES[k]}`);
    }
    for (const k of [...MATERIALS, ...GEAR]) popPrev[k] = inventory.counts[k];
    if (hotbar.slot !== 'hands' && inventory.counts[hotbar.slot] <= 0) hotbar.select('hands', () => true);
    renderHotbar();
    if (state === 'craft') { if (storeCrate) renderStore(); else renderCraft(); }
    recipeCheck?.();
  };
  // Switching tools flashes the item's name over the hotbar for a moment.
  const itemNameEl = $('itemname'); let itemNameTimer = 0, lastSlot = hotbar.slot;
  hotbar.onChange = () => {
    renderHotbar();
    if (hotbar.slot === lastSlot) return;
    lastSlot = hotbar.slot;
    itemNameEl.textContent = SLOT_NAMES[hotbar.slot];
    itemNameEl.classList.add('show'); clearTimeout(itemNameTimer);
    itemNameTimer = window.setTimeout(() => itemNameEl.classList.remove('show'), 1200);
  };
  inventory.load(meta?.inventory, meta?.fresh, meta?.seen, meta?.wear);
  // Recipes you've worked out: learning one (holding all its parts for the first time) is announced once.
  const known = new Set(RECIPES.filter((r) => knows(r, inventory.seen, scanned)).map((r) => r.id));
  recipeCheck = () => {
    for (const r of RECIPES) if (!known.has(r.id) && knows(r, inventory.seen, scanned)) {
      known.add(r.id);
      flash(`New recipe: ${ITEM_NAMES[r.makes]}  \u00b7  ${K('craft')} to craft`);
      audio.play('ui_2', { bus: 'ui', gain: 0.4, rate: 1.4 });
    }
  };
  /** Puts items in your pack; whatever doesn't fit is set down at your feet in a pack you can come back for. */
  const give = (id: ItemId, n: number, age = 0) => {
    const got = inventory.add(id, n, age);
    if (got < n) {
      const feet = player.position.clone().setY(player.position.y - 0.9);
      const g = world.groundAt(feet.x, feet.z);
      if (g && Math.abs(g.y - feet.y) < 1.5) feet.y = g.y;
      // Into the pack already lying here if there is one (each overflow used to drop a new pack, and past the pack cap
      // the oldest, maybe the one you died with, was emptied into it).
      const here = packs.near(feet, 2);
      if (here) here.items[id] = (here.items[id] ?? 0) + n - got;
      else packs.add(feet, { [id]: n - got });
      flash(`Pack full: left ${n - got} ${ITEM_NAMES[id].toLowerCase()} on the ground.`);
    }
    return got;
  };
  /** One use of a tool: warns when it's nearly spent, and when it breaks swaps in a spare (or your hands). */
  let durShown = '';
  const useTool = (id: ItemId) => {
    const r = inventory.wearOut(id);
    if (r === 'low') flash(`Your ${ITEM_NAMES[id].toLowerCase()} is wearing thin. Make a spare (${K('craft')}).`);
    else if (r === 'broke') {
      audio.play('crunch', { gain: 0.7, rate: 1.3 });
      flash(`Your ${ITEM_NAMES[id].toLowerCase()} broke.${inventory.counts[id] > 0 ? ' You take out a spare.' : ''}`);
    }
    const key = SLOTS.map((s) => (s === 'hands' ? '' : Math.round((inventory.condition(s) ?? 0) * 40))).join();
    if (key !== durShown) { durShown = key; renderHotbar(); } // the bars move in 2.5% steps
  };
  const packFull = (id: ItemId) => { audio.deny(); flash(`No room for ${ITEM_NAMES[id].toLowerCase()}: your carry slots are full (${inventory.usedSlots()}/${inventory.slots()}). Craft a bag or drop things at camp.`); };
  let craftMsgTimer = 0;
  const craftNote = (msg: string) => {
    craftMsg.textContent = msg;
    clearTimeout(craftMsgTimer);
    craftMsgTimer = window.setTimeout(() => { craftMsg.textContent = ''; }, 2500);
  };
  /** Crafts recipe `r` up to `times` times; reports what was made or what's missing. */
  const craft = (r: (typeof RECIPES)[number], times: number) => {
    if (!known.has(r.id)) { audio.deny(); craftNote('You haven\u2019t worked that one out yet: pick up its materials first.'); return; }
    if (r.place) { // built in the world: close the panel and show where it would go
      if (!inventory.has(r.cost)) { audio.deny(); craftNote(`Need ${(Object.keys(r.cost) as ItemId[]).filter((k) => inventory.counts[k] < (r.cost[k] ?? 0)).map((k) => `${(r.cost[k] ?? 0) - inventory.counts[k]} more ${ITEM_NAMES[k].toLowerCase()}`).join(' and ')}.`); return; }
      setState('playing'); if (!player.dragLook) void requestLock().catch(() => flash('Click to resume mouse look.'));
      build(r.id as PlaceKind);
      flash(`Place the ${ITEM_NAMES[r.makes].toLowerCase()}: ${K('build')} or click where it should go. Any other key cancels.`);
      return;
    }
    if (r.unique && inventory.counts[r.makes] > 0) { craftNote(`You already have a ${ITEM_NAMES[r.makes].toLowerCase()}.`); return; }
    const missing = (r.needs ?? []).filter((k) => inventory.counts[k] <= 0);
    if (missing.length) { audio.deny(); craftNote(`You need a ${missing.map((k) => ITEM_NAMES[k].toLowerCase()).join(' and a ')} for this.`); return; }
    if (r.heat && fireNearPlayer() <= 0.5) { audio.deny(); craftNote('This needs a lit fire close by. Craft it at your camp.'); return; }
    if (r.unique) times = 1;
    let made = 0;
    const first = inventory.counts[r.makes] === 0;
    if (inventory.room(r.makes) < r.amount && !r.tool && !r.unique) { packFull(r.makes); return; }
    while (made < times && inventory.room(r.makes) >= r.amount && inventory.take(r.cost)) { give(r.makes, r.amount); made++; }
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
  $('craftfilter').addEventListener('click', () => { craftableOnly = !craftableOnly; renderCraft(); });
  recipesEl.addEventListener('click', (e) => {
    const r = RECIPES.find((x) => x.id === (e.target as HTMLElement).dataset.r);
    if (r) craft(r, (e as MouseEvent).shiftKey ? 5 : 1);
  });


  // --- Crate storage: the crafting panel's other face. Click moves a stack, Shift+click all of that item. ------
  const storeMsg = (msg: string) => { const el = $('storemsg'); el.textContent = msg; clearTimeout(craftMsgTimer); craftMsgTimer = window.setTimeout(() => { el.textContent = ''; }, 2500); };
  const openStore = (c: Crate) => {
    storeCrate = c;
    setState('craft');
    if (document.pointerLockElement) document.exitPointerLock();
    audio.play('ui_2', { bus: 'ui', gain: 0.5, rate: 0.8 });
  };
  const cells = (inv: Inventory, side: 'pack' | 'crate') => {
    const ks = [...MATERIALS, ...TOOLS].filter((k) => inv.counts[k] > 0);
    if (!ks.length) return `<div class="stempty">${side === 'pack' ? 'Nothing carried' : 'Empty'}</div>`;
    return ks.map((k) => {
      const f = PERISHABLE.includes(k as Perishable) ? inv.freshness(k as Perishable) : null;
      const stale = f !== null && f < (SHELF_LIFE[k] ?? 0) * 0.25;
      const cond = inv.condition(k);
      return `<button class="cell${stale || (cond !== null && cond < 0.25) ? ' stale' : ''}" data-side="${side}" data-k="${k}" title="${ITEM_NAMES[k]}${f !== null ? ' · next spoils in ' + fmtTime(f * (side === 'crate' ? 2 : 1)) : ''}${cond !== null ? ` · ${Math.round(cond * 100)}% condition` : ''}">${ico(k)}<b>${inv.counts[k]}</b><i>${ITEM_NAMES[k]}</i></button>`;
    }).join('');
  };
  const crateFull = (c: { inv: Inventory }) => [...MATERIALS, ...TOOLS].some((k) => c.inv.counts[k] > 0);
  function renderStore() {
    const c = storeCrate;
    if (!c) return;
    const ld = inventory.load_();
    $('storeview').innerHTML = `<h2>Storage crate</h2>
      <p class="sub">Click moves a stack · Shift+click moves all of it · ${K('use')}, ${K('craft')} or Esc to close</p>
      <div class="stcols">
        <div class="stcol"><div class="sth"><span>Your pack</span><span class="load ${ld.name.toLowerCase()}">${inventory.usedSlots()}/${inventory.slots()} · ${inventory.weight().toFixed(1)} kg</span></div>
          <div class="stgrid">${cells(inventory, 'pack')}</div><button class="stall" data-act="storeall">Store everything ▸</button></div>
        <div class="stcol"><div class="sth"><span>Crate</span><span>${c.inv.usedSlots()}/${CRATE_SLOTS}</span></div>
          <div class="stgrid">${cells(c.inv, 'crate')}</div><button class="stall" data-act="takeall">◂ Take all that fits</button></div>
      </div>
      <div class="stfoot"><span class="hint">Meat keeps twice as long in a crate.</span><button class="stdis" data-act="dismantle"${crateFull(c) ? ' disabled title="Empty it first"' : ''}>Dismantle</button></div>
      <div id="storemsg"></div>`;
  }
  $('storeview').addEventListener('click', (e) => {
    const c = storeCrate;
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!c || !b || b.disabled) return;
    const shift = (e as MouseEvent).shiftKey;
    if (b.dataset.k) {
      const k = b.dataset.k as ItemId, from = b.dataset.side === 'pack' ? inventory : c.inv, to = from === inventory ? c.inv : inventory;
      const n = shift ? from.counts[k] : Math.min(from.counts[k], STACK[k] ?? 1);
      const moved = from.moveTo(to, k, n);
      if (moved) audio.play('ui_3', { bus: 'ui', gain: 0.35, rate: from === inventory ? 0.9 : 1.1 });
      else { audio.deny(); storeMsg(to === inventory ? 'Your carry slots are full.' : 'The crate is full.'); }
      renderStore();
    } else if (b.dataset.act === 'storeall' || b.dataset.act === 'takeall') {
      const from = b.dataset.act === 'storeall' ? inventory : c.inv, to = from === inventory ? c.inv : inventory;
      let moved = 0, left = 0;
      // Taking all brings stored tools too (they stayed behind, so the crate never emptied); storing all keeps yours.
      for (const k of from === inventory ? MATERIALS : [...MATERIALS, ...TOOLS]) if (from.counts[k] > 0) { moved += from.moveTo(to, k, from.counts[k]); left += from.counts[k]; }
      if (moved) audio.play('ui_3', { bus: 'ui', gain: 0.4 }); else audio.deny();
      storeMsg(left ? `${to === inventory ? 'Your carry slots are' : 'The crate is'} full: ${left} left behind.` : moved ? `Moved ${moved}.` : 'Nothing to move.');
      renderStore();
    } else if (b.dataset.act === 'dismantle') {
      if (crateFull(c)) { audio.deny(); storeMsg('Empty the crate first.'); return; } // tools take no slots: they counted as empty and were lost
      crates.remove(c);
      give('stalkwood', 3); give('cordage', 1); give('stone', 2);
      setState('playing'); if (!player.dragLook) void requestLock().catch(() => flash('Click to resume mouse look.'));
      flash('Crate taken apart: you salvage 3 stalkwood, 1 cordage and 2 stone.');
    }
  });

  // --- What you're looking at: one query, used by the prompt and by E ------------------------------
  type Target =
    | { kind: 'creature'; c: Creature }
    | { kind: 'prop'; p: NonNullable<ReturnType<Props['lookAt']>> }
    | { kind: 'fire'; f: NonNullable<ReturnType<Campfires['lookAt']>> }
    | { kind: 'stalk'; s: NonNullable<ReturnType<Flora['lookAt']>> }
    | { kind: 'pack'; pk: NonNullable<ReturnType<Packs['near']>> }
    | { kind: 'crate'; cr: Crate }
    | { kind: 'chip'; ch: NonNullable<ReturnType<Chips['lookAt']>> }
    | null;
  let target: Target = null;
  const queryTarget = (): Target => {
    const c = fauna.lookAt(camera, ATTACK.spear.reach);
    if (c) return { kind: 'creature', c };
    const pk = packs.near(player.position, 2.5);
    if (pk) return { kind: 'pack', pk };
    const cr = crates.lookAt(camera, USE_REACH);
    if (cr) return { kind: 'crate', cr };
    const f = campfires.lookAt(camera, USE_REACH);
    if (f) return { kind: 'fire', f };
    const ch = chips.lookAt(camera, USE_REACH);
    if (ch) return { kind: 'chip', ch };
    const p = props.lookAt(camera, USE_REACH);
    if (p) return { kind: 'prop', p };
    const s = flora.lookAt(camera, USE_REACH);
    if (s) return { kind: 'stalk', s };
    return null;
  };
  const promptFor = (t: Target) => {
    if (!t) return '';
    switch (t.kind) {
      case 'creature':
        return t.c.alive ? t.c.species.name
          : inventory.counts.stone_knife > 0 ? `${K('use')}  harvest ${t.c.species.name}` : `${t.c.species.name}  ·  needs a stone knife to harvest`;
      case 'prop': return `${K('use')}  pick up ${ITEM_NAMES[t.p.kind].toLowerCase()}`;
      case 'fire': {
        const cook = (t.f.ready.length ? `  \u00b7  ${K('eat')}  take ${t.f.ready.length} cooked meat` : '')
          + (t.f.cooking.length ? `  \u00b7  cooking ${Math.ceil(t.f.cooking[0])}s${t.f.cooking.length > 1 ? ` (+${t.f.cooking.length - 1})` : ''}${t.f.lit ? '' : ' (stopped)'}` : '')
          + (!t.f.ready.length && inventory.counts.raw_meat > 0 && t.f.lit && t.f.spitFree > 0 ? `  \u00b7  ${K('eat')}  ${t.f.cooking.length ? 'add' : 'cook'} raw meat` : '');
        return (t.f.lit ? `${K('use')}  add stalkwood  \u00b7  burns ${fmtTime(t.f.fuel)}` : `${K('use')}  relight with stalkwood`) + cook;
      }
      case 'chip': return `${K('use')}  read data chip`;
      case 'crate': return `${K('use')}  open crate  \u00b7  ${t.cr.inv.usedSlots()}/${CRATE_SLOTS} slots`;
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
  const aimAtTerrain = (reach: number) => {
    const hit = world.raycast(camera.position, camera.getWorldDirection(aimDir), reach);
    return hit && wreck.blocks(camera.position, aimDir, hit.distance) ? null : hit; // the hull is in the way
  };
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
      useTool('stone_knife');
      let spilled = false;
      for (const [k, n] of Object.entries(t.c.species.drops) as [ItemId, number][]) { if (give(k, n) < n) spilled = true; got.push(`${n} ${ITEM_NAMES[k].toLowerCase()}`); }
      hotbar.swing();
      if (audio.has('tear')) { audio.play('tear', { pos: t.c.position, offset: Math.random() * 9, dur: 1.4, gain: 0.9 }); audio.play('crunch', { pos: t.c.position, gain: 0.6, delay: 0.25 }); }
      else audio.chop(t.c.position);
      particles.burst(t.c.hitCentre(), 10, 0x7a3a3a, { speed: 2 });
      flash(`Harvested ${got.join(', ')}.${spilled ? ' Pack full: the rest is on the ground at your feet.' : ''}`); // (this replaced give's own note)
    } else if (t.kind === 'prop') {
      if (inventory.room(t.p.kind) < 1) { packFull(t.p.kind); return; }
      props.pick(t.p);
      audio.pickup(t.p.kind);
      give(t.p.kind, t.p.kind === 'fiber' && hotbar.slot === 'stone_knife' ? 2 : 1);
      if (t.p.kind === 'fiber' && hotbar.slot === 'stone_knife') useTool('stone_knife');
      hotbar.swing();
    } else if (t.kind === 'fire') {
      if (t.f.fuel >= FUEL_MAX - 1) flash('The fire is fully stoked.');
      else if (inventory.take({ stalkwood: 1 })) { campfires.addFuel(t.f); audio.fireLit(t.f.position); }
      else { audio.deny(); flash('You need stalkwood to feed the fire.'); }
    } else if (t.kind === 'chip') {
      chips.take(t.ch);
      scanned.add(t.ch.id);
      audio.play('ui_3', { bus: 'ui', gain: 0.6, rate: 0.9 });
      tutorial.milestone('chip');
      recipeCheck?.(); // (its "New recipe" note is replaced by the fuller line below)
      const learned = RECIPES.find((r) => r.scan === t.ch.id);
      flash(`Data chip read: ${t.ch.name}. New recipe: ${learned ? ITEM_NAMES[learned.makes] : '?'} (${K('craft')}). ${chips.list.length ? `${CHIPS.length - chips.list.length}/${CHIPS.length} chips found.` : 'That was the last chip.'}`);
    } else if (t.kind === 'crate') {
      openStore(t.cr);
    } else if (t.kind === 'pack') {
      const got: string[] = [];
      let rotten = 0;
      // Take what fits; the rest stays in the pack. Meat that sat out comes back half-spoiled.
      for (const [k, n] of Object.entries(t.pk.items)) if (Object.hasOwn(inventory.counts, k) && n > 0) {
        const id = k as ItemId, half = (SHELF_LIFE[id] ?? 0) * 0.5, ages = t.pk.ages?.[k] ?? [];
        // Each piece comes back at least half-spoiled, never fresher than it went in (dying used to refresh rotting meat).
        let took = 0, rot = 0;
        if (SHELF_LIFE[id]) { for (let j = 0; j < n; j++) { const a = Math.max(half, ages[j] ?? 0); if (a >= (SHELF_LIFE[id] ?? 0)) { took++; rot++; continue; } if (!inventory.add(id, 1, a)) break; took++; } ages.splice(0, took); }
        else took = inventory.add(id, n);
        if (took - rot) got.push(`${took - rot} ${ITEM_NAMES[id].toLowerCase()}`);
        if (rot) rotten += rot;
        if (took >= n) delete t.pk.items[k]; else t.pk.items[k] = n - took;
      }
      const left = Object.keys(t.pk.items).length > 0;
      if (!left) packs.remove(t.pk);
      if (got.length) audio.pickup('fiber'); else audio.deny();
      const rotNote = rotten ? ` ${rotten} piece${rotten > 1 ? 's' : ''} of meat had rotted: you throw ${rotten > 1 ? 'them' : 'it'} away.` : '';
      flash((got.length ? `Recovered ${got.join(', ')}.${left ? ' Your slots are full: the rest is still in the pack.' : ''}` : left ? 'No room: your carry slots are full.' : rotten ? '' : 'The pack was empty.') + rotNote);
    } else if (t.kind === 'stalk') {
      if (inventory.counts.stone_knife <= 0 && inventory.counts.stone_pick <= 0) { flash('Cut stalkwood with a stone knife or pick.'); return; }
      if (inventory.room('stalkwood') < 1) { packFull('stalkwood'); return; }
      const got = flora.harvest(t.s);
      if (got) {
        useTool(hotbar.slot === 'stone_knife' || hotbar.slot === 'stone_pick' ? hotbar.slot : inventory.counts.stone_knife > 0 ? 'stone_knife' : 'stone_pick');
        give('stalkwood', got); hotbar.swing();
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
  /** Drains in 5 minutes, so trips away from the fire need planning; refills by a fire (1 minute) or slowly in daylight. Flickers when low or when the core glitches. */
  let solarHinted = false;
  const updateLamp = (dt: number, fireNear: number) => {
    const cell = inventory.counts.lamp_cell > 0; // the salvaged power cell: half the drain, faster recharge
    if (lampOn) { lampCharge = Math.max(0, lampCharge - dt * (100 / 300) * (cell ? 0.5 : 1)); if (lampCharge <= 0) { lampOn = false; flash('Lamp charge depleted.'); } }
    // Daylight charging needs the sky: not in a cave or under the wreck (it charged deep underground at noon).
    else lampCharge = Math.min(100, lampCharge + dt * (fireNear > 0.3 ? 100 / 60 : sky.daylight > 0.5 && !survival.sheltered ? 100 / 300 : 0) * (cell ? 1.5 : 1));
    // A solar panel in daylight charges it fast even while it's on.
    if (sky.daylight > 0.25 && lampCharge < 100 && placeables.solarNear(player.position, 6)) {
      lampCharge = Math.min(100, lampCharge + dt * (100 / 20));
      if (!solarHinted) { solarHinted = true; flash('The solar panel is charging your lamp.'); }
    } else if (!placeables.solarNear(player.position, 8)) solarHinted = false;
    let k = lampOn ? 1 : 0;
    if (lampOn && !settings.reduceFlash && (horror.glitch > 0 || (lampCharge < 15 && Math.random() < 0.08))) k = Math.random() < 0.5 ? 0.1 : 0.7;
    lamp.intensity = 34 * k * (lampCharge < 15 ? 0.6 : 1);
  };

  /** Q: cook raw meat on the fire you're looking at, otherwise eat cooked meat. */
  const food = () => {
    const f = campfires.lookAt(camera, USE_REACH);
    if (f && f.ready.length) { // cooked pieces waiting on the spit come off first
      const n = Math.min(f.ready.length, inventory.room('cooked_meat'));
      if (n < 1) { packFull('cooked_meat'); return; }
      for (const age of f.ready.splice(0, n)) inventory.add('cooked_meat', 1, age);
      audio.pickup('fiber');
      flash(`Took ${n} cooked meat off the spit.${f.ready.length ? ` ${f.ready.length} left: no room.` : ''}`);
      return;
    }
    if (f && inventory.counts.raw_meat > 0) {
      if (!f.lit) { audio.deny(); flash(`Light the fire first: ${K('use')} with stalkwood.`); return; }
      if (f.spitFree < 1) { flash('The spit is full.'); return; }
      if (f.fuel < COOK_TIME * (f.cooking.length + 1)) flash(`The fire won't last that long: add stalkwood (${K('use')}) or it stops cooking.`);
      inventory.take({ raw_meat: 1 });
      f.cooking.push(COOK_TIME);
      audio.fireLit(f.position);
      if (f.fuel >= COOK_TIME * f.cooking.length) flash(`Cooking. It takes ${COOK_TIME} seconds; keep the fire lit.`);
      return;
    }
    if (inventory.counts.cooked_meat > 0) {
      // Fed tops out at two meals: eating at the cap used to burn the meat for nothing.
      if (survival.fed > TEMP.fedTime * 2 - 30) { audio.deny(); flash(`You're full. Fed for ${fmtTime(survival.fed)}.`); return; }
      inventory.take({ cooked_meat: 1 });
      survival.fed = Math.min(TEMP.fedTime * 2, survival.fed + TEMP.fedTime);
      audio.pickup('fiber');
      flash(`Fed for ${fmtTime(survival.fed)}: you heal faster and hold your heat longer.`);
      return;
    }
    audio.deny();
    flash(inventory.counts.raw_meat > 0 ? `Cook raw meat first: look at a lit fire and press ${K('eat')}.` : 'Nothing to eat. Hunt, then cook the meat at a fire.');
  };
  // Cooked meat comes to you only when you're at the fire with room for it. It used to jump into your pack from anywhere
  // (or spill a pack at your feet a kilometre away): now it waits on the spit.
  campfires.onCooked = (f) => {
    tutorial.milestone('cooked');
    const d = f.position.distanceTo(player.position);
    if (d < USE_REACH + 1 && state !== 'dead' && inventory.room('cooked_meat') > 0) {
      give('cooked_meat', 1);
      audio.pickup('fiber'); flash('Meat cooked.');
    } else {
      f.ready.push(0);
      if (d < 12 && state !== 'dead') flash(`Meat cooked: it's waiting on the spit (${K('eat')} at the fire to take it).`);
    }
  };
  campfires.onOut = (f) => {
    if (state === 'dead' || f.position.distanceTo(player.position) > 15) return;
    flash(f.cooking.length ? `The fire went out with meat on the spit. Feed it stalkwood (${K('use')}) to finish cooking.` : 'The fire burned out.');
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
  let handLit = 1;
  const syncHandLights = (dt: number) => {
    camInv.copy(camera.quaternion).invert();
    handHemi.color.copy(sky.hemi.color); handHemi.groundColor.copy(sky.hemi.groundColor); handHemi.intensity = sky.hemi.intensity;
    // The held tool has its own lights (separate scene, no shadow map): dim its sun when you stand in shade, under a cap or
    // a roof, or it glowed sunlit in the dark of a pit.
    handLit += ((survival.shaded || survival.sheltered ? 0.12 : 1) - handLit) * Math.min(1, dt * 4);
    handSun.color.copy(sky.sun.color); handSun.intensity = sky.sun.intensity * handLit;
    handSun.position.copy(tv.subVectors(sky.sun.position, sky.sun.target.position).normalize().applyQuaternion(camInv)).multiplyScalar(5);
    let near: THREE.Vector3 | null = null, nd = 14, str = 0;
    for (const f of campfires.list) { const d = f.position.distanceTo(camera.position); if (f.lit && d < nd) { nd = d; near = f.position; str = f.heat.heatC / 62; } }
    handFire.intensity = near ? 7 * str * Math.max(0, 1 - nd / 14) : 0;
    if (near) handFire.position.copy(tv.copy(near).setY(near.y + 0.9).sub(camera.position)).applyQuaternion(camInv).normalize().multiplyScalar(1.5);
    handLamp.intensity = lamp.intensity > 1 ? 0.14 : 0; // spill from the wrist lamp: just enough to read the tool
  };

  const MAX_FIRES = 40;
  type PlaceKind = 'fire' | 'crate' | 'flare' | 'solar';
  const costOf = (id: string) => RECIPES.find((r) => r.id === id)!.cost;
  const crateCost = costOf('crate');
  /** Why a campfire (or crate) can't go where you're aiming ('' if it can). */
  const placeProblem = (hit: { point: THREE.Vector3; normal: THREE.Vector3 } | null, kind: PlaceKind = 'fire'): string => {
    if (kind === 'flare') {
      if (!hit || hit.normal.y < 0.5) return 'Look at the ground nearby to plant the flare.';
      if (hit.point.distanceTo(player.position.clone().setY(player.position.y - 0.9)) < 0.6) return 'Step back a little to plant it here.';
      if (!inventory.has(costOf('flare'))) return 'You no longer have the materials for a flare.';
      return '';
    }
    if (kind === 'solar') {
      if (!hit || hit.normal.y < 0.8) return 'Look at flatter ground nearby to set up the panel.';
      if (wreck.debrisAt(hit.point.x, hit.point.z, 0.6)) return 'A hull plate is in the way.';
      if ([...crates.list.map((c) => c.position), ...placeables.solars.map((s) => s.pos), ...campfires.list.map((f) => f.position)].some((p) => p.distanceTo(hit.point) < 1.4)) return 'Too close to something else.';
      if (flora.trunkAt(hit.point.x, hit.point.z, 0.7)) return 'A mushroom is in the way.';
      if (hit.point.distanceTo(player.position.clone().setY(player.position.y - 0.9)) < 1.0) return 'Step back a little to set it up here.';
      if (placeables.solars.length >= MAX_SOLARS) return `You have ${MAX_SOLARS} panels already.`;
      if (!inventory.has(costOf('solar'))) return 'You no longer have the materials for a panel.';
      return '';
    }
    if (kind === 'crate') {
      if (!hit || hit.normal.y < 0.8) return 'Look at flatter ground nearby to place the crate.';
      if (wreck.debrisAt(hit.point.x, hit.point.z, 0.6)) return 'A hull plate is in the way.';
      if (crates.list.some((c) => c.position.distanceTo(hit.point) < 1.1)) return 'Too close to another crate.';
      if (campfires.list.some((f) => f.position.distanceTo(hit.point) < 1.3)) return 'Too close to the fire.';
      if (placeables.solars.some((s) => s.pos.distanceTo(hit.point) < 1.4)) return 'Too close to the solar panel.';
      if (flora.trunkAt(hit.point.x, hit.point.z, 0.6)) return 'A mushroom is in the way.';
      if (hit.point.distanceTo(player.position.clone().setY(player.position.y - 0.9)) < 1.0) return 'Step back a little to place it here.';
      if (crates.list.length >= MAX_CRATES) return `You have ${MAX_CRATES} crates already.`;
      if (!inventory.has(crateCost)) return 'You no longer have the materials for a crate.';
      return '';
    }
    if (!hit || hit.normal.y < 0.7) return 'Look at flatter ground nearby to build a campfire.';
    if (wreck.debrisAt(hit.point.x, hit.point.z, 0.5)) return 'A hull plate is in the way.';
    // Guards: not on top of another fire (spamming B stacked them), not inside your own feet, and a sane total.
    if (campfires.list.some((f) => f.position.distanceTo(hit.point) < 1.6)) return 'Too close to another fire.';
    // Fires went anywhere else: into a crate or a solar panel (their colliders overlapping), or the foot of a mushroom.
    if (crates.list.some((c) => c.position.distanceTo(hit.point) < 1.3)) return 'Too close to the crate.';
    if (placeables.solars.some((s) => s.pos.distanceTo(hit.point) < 1.4)) return 'Too close to the solar panel.';
    if (placeables.flares.some((f) => f.pos.distanceTo(hit.point) < 0.9)) return 'A flare is in the way.';
    if (flora.trunkAt(hit.point.x, hit.point.z, 0.6)) return 'A mushroom is in the way.';
    if (hit.point.distanceTo(player.position.clone().setY(player.position.y - 0.9)) < 0.9) return 'Step back a little to build here.';
    // At the cap, the oldest cold fire pit is cleared to make room; if every fire is burning, refuse.
    if (campfires.list.length >= MAX_FIRES && !campfires.list.some((f) => !f.lit && f.cooking.length === 0 && f.ready.length === 0))
      return campfires.list.every((f) => f.lit) ? `You have ${MAX_FIRES} fires burning already.` : `You have ${MAX_FIRES} fires already, and the cold ones still have meat on the spit: take it off first.`;
    if (!inventory.has(CAMPFIRE_COST)) return `A campfire needs ${CAMPFIRE_COST.stalkwood} stalkwood and ${CAMPFIRE_COST.stone} stone.`;
    return '';
  };
  // Placement: the first press shows a see-through fire ring where it would go (green when it fits, red when not); a
  // second press, or a click, builds it. Anything else, or 8 seconds, cancels.
  const preview = campfires.makePreview();
  scene.add(preview.group);
  let placing = 0, digBlock = false, placeKind: PlaceKind = 'fire';
  const cancelPlacing = () => { placing = 0; for (const p of [preview, cratePreview, flarePreview, solarPreview]) p.group.visible = false; };
  /** First call shows where it would go; the second builds it. */
  const build = (kind: PlaceKind = 'fire') => {
    if (!placing) { placeKind = kind; placing = kind === 'fire' ? 8 : 15; return; }
    const k = placeKind;
    cancelPlacing();
    const hit = aimAtTerrain(5);
    const problem = placeProblem(hit, k);
    if (problem || !hit) { audio.deny(); flash(problem); return; }
    if (k === 'flare') {
      inventory.take(costOf('flare'));
      placeables.addFlare(hit.point.clone());
      audio.fireLit(hit.point);
      flash(`Flare lit. It burns for ${FLARE_TIME / 60} minutes.`);
      return;
    }
    if (k === 'solar') {
      inventory.take(costOf('solar'));
      placeables.addSolar(hit.point.clone(), player.yaw, hit.normal.x, hit.normal.z);
      audio.place(hit.point);
      flash('Solar panel set up. In daylight, stand near it to charge your wrist lamp.');
      return;
    }
    if (k === 'crate') {
      inventory.take(crateCost);
      crates.add(hit.point.clone(), player.yaw, undefined, undefined, undefined, hit.normal.x, hit.normal.z);
      audio.place(hit.point);
      flash(`Crate built. ${K('use')} to open it: 16 slots, and meat keeps twice as long inside.`);
      return;
    }
    inventory.take(CAMPFIRE_COST);
    if (campfires.list.length >= MAX_FIRES) campfires.remove(campfires.list.find((f) => !f.lit && f.cooking.length === 0 && f.ready.length === 0)!); // paid for: now clear the oldest cold pit
    campfires.add(hit.point.clone(), FUEL_START, hit.normal.x, hit.normal.z);
    audio.place(hit.point);
    flash(`Campfire built. Add stalkwood (${K('use')}) to keep it burning.`);
  };
  const updatePlacing = (dt: number) => {
    if (!placing) return;
    if ((placing -= dt) <= 0 || state !== 'playing') { cancelPlacing(); return; }
    const hit = aimAtTerrain(5);
    const pv = { fire: preview, crate: cratePreview, flare: flarePreview, solar: solarPreview }[placeKind];
    pv.group.visible = !!hit;
    if (hit) {
      pv.group.position.copy(hit.point);
      const yaw = placeKind === 'crate' || placeKind === 'solar' ? player.yaw : 0;
      pv.group.quaternion.setFromUnitVectors(UP, hit.normal).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw)); // preview sits on the slope like the real thing
      if (placeKind === 'flare') pv.group.quaternion.setFromAxisAngle(UP, 0);
      pv.setOk(!placeProblem(hit, placeKind));
    }
    promptEl.textContent = `${K('build')} or click: ${{ fire: 'build', crate: 'place crate', flare: 'plant flare', solar: 'set up panel' }[placeKind]} here  \u00b7  ${placeProblem(hit, placeKind) || 'fits'}`;
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
    if (hit && hotbar.slot !== 'hands') useTool(hotbar.slot);
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
    const at = fill ? hit.point.clone().addScaledVector(hit.normal, 0.6) : hit.point;
    // Not out from under (or on top of) things you've placed: a crate, fire or panel was left floating over the hole,
    // or buried by the fill, and a pack or chip could vanish into the ground.
    const near = (q: THREE.Vector3, pad: number) => Math.hypot(q.x - at.x, q.z - at.z) < power.radius + pad && Math.abs(q.y - at.y) < power.radius + 1.5;
    const inWay = crates.list.some((c) => near(c.position, 0.6)) ? 'A crate' : campfires.list.some((f) => near(f.position, 0.7)) ? 'Your campfire'
      : placeables.solars.some((p) => near(p.pos, 0.8)) ? 'The solar panel' : placeables.flares.some((f) => near(f.pos, 0.3)) ? 'The flare'
      : packs.list.some((p) => near(p.position, 0.4)) ? 'A pack' : chips.list.some((c) => c.placed && near(c.group.position, 0.3)) ? 'A data chip'
      : wreck.placed && wreck.covers(at.x, at.z, power.radius * 0.5) && at.y < wreck.center.y + 1 ? 'The wreck' : ''; // it would hang over the hole
    if (inWay) { audio.deny(); flash(`${inWay} is in the way.`); return; }
    if (fill && at.distanceTo(player.position) < power.radius + 0.9) { audio.deny(); flash('Too close: step back to fill.'); return; } // don't bury yourself
    if (hotbar.slot !== 'hands') useTool(hotbar.slot);
    const col = hit.normal.y < 0.6 ? 0x8a6d86 : 0x4f8a7a; // rock on slopes, moss on flat ground
    if (!fill) {
      world.brush(hit.point, power.radius, power.strength, -1);
      wreck.clearDebrisNear(hit.point, power.radius);
      audio.dig(hit.point, hotbar.slot === 'stone_pick');
      particles.burst(hit.point, hotbar.slot === 'stone_pick' ? 12 : 8, col, { up: hit.normal.clone(), speed: 3 });
    } else {
      const p = at;
      world.brush(p, power.radius, power.strength, +1);
      wreck.clearDebrisNear(p, power.radius);
      audio.fill(p);
      particles.burst(p, 5, col, { speed: 1.5, life: 0.5 });
    }
  };

  // --- Keys that aren't held actions --------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F1') { e.preventDefault(); document.body.classList.toggle('nohud'); return; } // screenshots: hide every HUD element
    if (e.code === 'F3') { e.preventDefault(); hud.style.display = hud.style.display === 'none' ? '' : 'none'; return; }
    if (e.code === 'F5') { e.preventDefault(); void saveNow().then((ok) => flash(ok ? 'Saved' : 'Not saved')); return; }
    if (input.is(e.code, 'craft') && (state === 'playing' || state === 'craft')) { // Tab stays free for menu focus
      e.preventDefault();
      if (state === 'craft') { setState('playing'); if (!player.dragLook) void requestLock().catch(() => flash('Click to resume mouse look.')); }
      else if (state === 'playing') { setState('craft'); if (document.pointerLockElement) document.exitPointerLock(); }
      return;
    }
    if (state === 'craft' && storeCrate) { // the crate view: E (or Tab/Esc, below) closes it; nothing else
      if (input.is(e.code, 'use') && !e.repeat) { setState('playing'); if (!player.dragLook) void requestLock().catch(() => flash('Click to resume mouse look.')); return; }
      if (e.code !== 'Escape') return;
    }
    if (state === 'craft' && e.code === 'KeyF') { craftableOnly = !craftableOnly; renderCraft(); return; }
    if (e.code === 'Escape') {
      // Esc isn't a user gesture, so it can't recapture the mouse: go to the pause menu, whose button can.
      if (state === 'craft') setState(player.dragLook ? 'playing' : 'menu');
      else if (state === 'playing' && player.dragLook) setState('menu');
      return;
    }
    if (state === 'craft' && !e.repeat) {
      const n = e.key === '0' ? 10 : Number(e.key);
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
    else if (input.is(e.code, 'build')) build();
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

  if (import.meta.env.DEV) Object.assign(window, { __bc: { wreck, packs, crates, placeables, chips, world, player, camera, saveNow, store, sky, survival, props, inventory, campfires, hotbar, fauna, flora, input, audio, particles, horror, post, renderer, scene, getState: () => state, setNights: (n: number) => { nights = n; } } });

  // --- HUD -----------------------------------------------------------------------------------------
  const deathEl = $('death'), frostEl = $('frost'), promptEl = $('prompt');
  const hpBar = document.querySelector('#hp > div') as HTMLElement, heatBar = document.querySelector('#heat > div') as HTMLElement;
  const fahrenheit = navigator.language === 'en-US';
  const fmtTemp = (c: number) => (fahrenheit ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`);
  const goalEl = $('goal'), buffsEl = $('buffs'), deathText = $('deathtext'), deathHint = $('deathhint');
  // Only touch the DOM when a value actually changes (no per-frame style writes).
  const domCache = new Map<HTMLElement, string>();
  const setText = (el: HTMLElement, v: string) => { if (domCache.get(el) !== v) { domCache.set(el, v); el.textContent = v; } };
  const setStyle = (el: HTMLElement, prop: 'transform' | 'opacity' | 'backgroundColor', v: string) => {
    const k = `${prop}:${v}`;
    if ((el.dataset.s ?? '') !== k) { el.dataset.s = k; el.style[prop] = v; }
  };
  // Contextual vitals: health shows when hurt or for a few seconds after it changes; body heat only while you're
  // losing it or cold. The "Always show vitals and inventory" setting keeps everything up.
  const hpGroup = $('hpgroup'), heatGroup = $('heatgroup'), hpvEl = $('hpv'), heatLabelEl = $('heatlabel'), tempvEl = $('tempv');
  let lastHp = -1, lastHeat = -1, hpShowT = 0, heatShowT = 0, vitalsClock = performance.now(), heatTrend = 0, heatPrev = survival.warmth;
  const showGroup = (el: HTMLElement, on: boolean) => { if (el.classList.contains('faded') === on) el.classList.toggle('faded', !on); };
  const updateVitals = () => {
    const now = performance.now(), dtv = (now - vitalsClock) / 1000; vitalsClock = now;
    // Pops up on a loss, not while healing (slow regen kept the bar on screen the whole time).
    if (survival.health < lastHp - 0.25) { hpShowT = 4; lastHp = survival.health; } else if (survival.health > lastHp || lastHp < 0) lastHp = survival.health;
    if (survival.warmth < lastHeat - 0.4) { heatShowT = 4; lastHeat = survival.warmth; } else if (survival.warmth > lastHeat) lastHeat = survival.warmth;
    heatTrend = heatTrend * 0.6 + THREE.MathUtils.clamp(survival.warmth - heatPrev, -1, 1) * 0.4; heatPrev = survival.warmth; // (clamped: a jump, like respawning at 60%, must not mask the trend for seconds)
    hpShowT = Math.max(0, hpShowT - dtv); heatShowT = Math.max(0, heatShowT - dtv);
    showGroup(hpGroup, settings.fullHud || survival.health < 75 || hpShowT > 0);
    showGroup(heatGroup, settings.fullHud || survival.cold || survival.warmth < 60 || heatShowT > 0);
    setStyle(hpBar, 'transform', `scaleX(${(survival.health / 100).toFixed(3)})`);
    setStyle(heatBar, 'transform', `scaleX(${(survival.warmth / 100).toFixed(3)})`);
    setStyle(heatBar, 'backgroundColor', survival.warmth > 60 ? '#e0a050' : survival.warmth > 30 ? '#c9b98a' : '#8fc3e8');
    setText(hpvEl, String(Math.ceil(survival.health)));
    // By the trend: "cooling" while you warm up at a fire was wrong.
    setText(heatLabelEl, heatTrend > 0.02 && survival.warmth < 100 ? (survival.cold ? '\u2744 Body heat \u00b7 warming' : 'Body heat \u00b7 warming') : survival.cold ? '\u2744 Body heat \u00b7 freezing' : survival.warmth < 60 ? 'Body heat \u00b7 cooling' : 'Body heat');
    setText(tempvEl, `air ${fmtTemp(survival.ambientC)}${survival.sheltered ? ' · sheltered' : survival.shaded ? ' · shade' : ''}`);
    setStyle(frostEl, 'opacity', Math.max(0, (45 - survival.warmth) / 45).toFixed(2));
    // Inventory list: only for a few seconds after something changes (or always, with the setting on).
    invShowT = Math.max(0, invShowT - dtv);
    if (invEl.classList.contains('faded') === (settings.fullHud || invShowT > 0)) invEl.classList.toggle('faded');
    const buffs = [lampOn || lampCharge < 100 ? `Lamp ${Math.round(lampCharge)}%${lampOn ? '' : ` (${K('lamp')})`}` : '', survival.fed > 0 ? `Fed ${fmtTime(survival.fed)}` : '', survival.wrapped ? 'Hide wrap' : '', survival.afterglow > 0 ? `Recovering ${fmtTime(survival.afterglow)}` : '', inventory.load_().name !== 'Light' ? inventory.load_().name : ''].filter(Boolean).join('  \u00b7  ');
    // The sky is the only other clock: a readout of time until dark, or until dawn.
    const until = (to: number) => fmtTime((((to - sky.time) % 1) + 1) % 1 * DAY_LENGTH);
    const clock = sky.time > 0.55 && sky.time < 0.75 ? `Dark in ${until(0.75)}` : isNightTime() ? `Dawn in ${until(0.27)}` : '';
    const line = [clock, buffs].filter(Boolean).join('  \u00b7  ');
    if (buffsEl.textContent !== line) buffsEl.textContent = line;
    const goal = tutorial.currentGoal();
    const goalText = goal ? `\u25B8 ${goal}` : '';
    if (goalEl.textContent !== goalText) goalEl.textContent = goalText;
    if (horror.glitch > 0) { // the wrist readout misbehaves for a moment (and shows itself to do it)
      showGroup(hpGroup, true); showGroup(heatGroup, true);
      setText(tempvEl, `air ${fmtTemp(-60 + Math.random() * 140)}`);
      setText(hpvEl, String(Math.floor(Math.random() * 999)));
      setText(heatLabelEl, Math.random() < 0.5 ? 'Body heat' : 'B\u0336ody h\u0336eat');
    }
  };

  // --- Wrist link: exact readouts, the objective and everything you carry, on the arm screen ------------------
  // Hold I to peek, tap it to pin. The world keeps running while you read it.
  const wristEl = $('wrist'), wristBody = $('wristbody'), dimmerEl = $('dimmer'), vitalsEl = $('vitals');
  let wristOpen = false, wristPinned = false, wristDown = 0, wristTimer = 0;
  const setWrist = (on: boolean) => {
    if (on === wristOpen) return;
    wristOpen = on;
    wristEl.classList.toggle('open', on); dimmerEl.classList.toggle('on', on); canvas.classList.toggle('soft', on || state === 'craft'); vitalsEl.classList.toggle('under-wrist', on);
    audio.play('ui_2', { bus: 'ui', gain: 0.25, rate: on ? 1.25 : 0.9 });
    if (on) renderWrist();
  };
  /** At high unease the screen corrupts a few characters (the HUD distortion setting; never the numbers you act on). */
  const corrupt = (t: string) => {
    const u = settings.hudDistortion && !settings.reduceFlash ? Math.max(0, horror.level - 0.45) * 0.12 : 0;
    if (u <= 0 && horror.glitch <= 0) return t;
    const p = horror.glitch > 0 ? 0.25 : u;
    return t.replace(/[A-Za-z]/g, (c) => (Math.random() < p ? '\u2591\u2592\u2593#%'[Math.floor(Math.random() * 5)] : c));
  };
  const meter = (cls: string, v: number) => `<div class="meter ${cls}"><i style="transform:scaleX(${Math.max(0, Math.min(1, v)).toFixed(3)})"></i></div>`;
  function renderWrist() {
    const until = (to: number) => fmtTime((((to - sky.time) % 1) + 1) % 1 * DAY_LENGTH);
    const clock = isNightTime() ? `dawn in ${until(0.25)}` : `dark in ${until(0.7)}`;
    const carried = [...MATERIALS, ...TOOLS, ...GEAR].filter((k) => inventory.counts[k] > 0);
    const goal = tutorial.currentGoal();
    wristBody.innerHTML = `
      <div class="kv"><span>${corrupt('VITALS')}</span><span>${clock} \u00b7 ${nights} night${nights === 1 ? '' : 's'} survived</span></div>
      <div class="kv"><span>${corrupt('Health')}</span><b>${Math.ceil(survival.health)} / 100</b></div>${meter('hp', survival.health / 100)}
      <div class="kv"><span>${corrupt('Body heat')}</span><b>${Math.round(survival.warmth)}% \u00b7 air ${fmtTemp(survival.ambientC)}</b></div>${meter('heat', survival.warmth / 100)}
      <div class="kv"><span>${corrupt('Lamp charge')}</span><b>${Math.round(lampCharge)}%${lampOn ? ' \u00b7 on' : ''}</b></div>${meter('', lampCharge / 100)}
      ${survival.fed > 0 ? `<div class="kv"><span>${corrupt('Fed')}</span><b>${fmtTime(survival.fed)}</b></div>` : ''}
      ${survival.wrapped ? `<div class="kv"><span>${corrupt('Hide wrap')}</span><b>worn</b></div>` : ''}
      ${goal ? `<div class="sec goal">\u25B8 ${goal}</div>` : ''}
      ${TOOLS.filter((k) => inventory.counts[k] > 0).map((k) => `<div class="kv"><span>${corrupt(ITEM_NAMES[k])}</span><b>${Math.round((inventory.condition(k) ?? 0) * 100)}% condition${inventory.counts[k] > 1 ? ` \u00b7 +${inventory.counts[k] - 1} spare` : ''}</b></div>`).join('')}
      <div class="kv"><span>${corrupt('Data chips')}</span><b>${CHIPS.length - chips.list.length}/${CHIPS.length} found${chips.list.length ? ' \u00b7 scattered round the wreck' : ''}</b></div>
      <div class="kv"><span>${corrupt('Load')}</span><b>${inventory.usedSlots()}/${inventory.slots()} slots \u00b7 ${inventory.weight().toFixed(1)} kg \u00b7 ${inventory.load_().name}</b></div>
      ${PERISHABLE.map((k) => { const f = inventory.freshness(k); return f === null ? '' : `<div class="kv"><span>${corrupt(ITEM_NAMES[k])}</span><b>next spoils in ${fmtTime(f)}</b></div>`; }).join('')}
      <div class="sec"><div class="kv"><span>${corrupt('CARRIED')}</span><span>${K('craft')}: craft</span></div>
        <div class="grid">${carried.map((k) => `<span>${ico(k)}${inventory.counts[k] > 1 || MATERIALS.includes(k) ? inventory.counts[k] : '\u2713'}</span>`).join('') || '<span>nothing</span>'}</div></div>`;
  }
  window.addEventListener('keydown', (e) => {
    if (!input.is(e.code, 'wrist') || e.repeat) return;
    if (state !== 'playing') return;
    wristDown = performance.now();
    setWrist(true);
  });
  window.addEventListener('keyup', (e) => {
    if (!input.is(e.code, 'wrist') || !wristDown) return;
    const tap = performance.now() - wristDown < 250;
    wristDown = 0;
    if (tap) { wristPinned = !wristPinned; setWrist(wristPinned); } // a tap pins it open (or closes it)
    else if (!wristPinned) setWrist(false);
  });
  const updateWrist = (dt: number) => {
    if (state !== 'playing' && wristOpen) { wristPinned = false; setWrist(false); }
    if (wristOpen && (wristTimer -= dt) <= 0) { wristTimer = 0.25; renderWrist(); }
  };

  // --- Wrist scan: hold the scan key on a creature (alive or dead) to analyse it. Scans teach the advanced recipes.
  const SCAN_TIME = 1.6, SCAN_RANGE = 14;
  const setPrompt = (t: string) => { if (promptEl.textContent !== t) promptEl.textContent = t; };
  let scanT = 0, scanTick = 0, scanning = false, scanDone = false, scanOf: Creature | null = null;
  let scanLost = 0;
  const scanDir = new THREE.Vector3(), scanTo = new THREE.Vector3();
  const scanPick = (): Creature | null => {
    camera.getWorldDirection(scanDir);
    let best: Creature | null = null, bestA = Infinity;
    for (const c of fauna.list) {
      scanTo.copy(c.hitCentre()).sub(camera.position);
      const d = scanTo.length();
      if (d > SCAN_RANGE || d < 0.3) continue;
      scanTo.multiplyScalar(1 / d);
      const ang = scanDir.angleTo(scanTo) * 180 / Math.PI;
      if (ang > (c === scanOf ? 16 : 9) || ang >= bestA) continue;
      const hit = world.raycast(camera.position, scanTo, d); // terrain in the way blocks the scan
      if (hit && hit.point.distanceTo(camera.position) < d - 0.4) continue;
      best = c; bestA = ang;
    }
    return best;
  };
  const updateScan = (dt: number) => {
    if (state !== 'playing' || !input.down('scan')) { scanning = false; scanDone = false; scanOf = null; scanT = 0; return; }
    if (scanDone) return;
    scanning = true;
    // A forgiving cone (small, quick creatures are hard to keep under the crosshair): the current target holds within
    // 16 degrees, a new one needs 9; losing it briefly only pauses the scan.
    const c = scanPick();
    if (!c) {
      scanLost += dt;
      if (scanLost > 0.8) { scanOf = null; scanT = 0; }
      setPrompt(scanOf ? `Scanning ${scanOf.species.name}… keep it in view` : 'Scanning… no lifeform in view');
      return;
    }
    scanLost = 0;
    if (c !== scanOf) { scanOf = c; scanT = 0; }
    scanT += dt;
    if ((scanTick -= dt) <= 0) { scanTick = 0.18; audio.play('ui_2', { bus: 'ui', gain: 0.12, rate: 1.5 + scanT * 0.4 }); }
    const n = Math.min(10, Math.floor((scanT / SCAN_TIME) * 10));
    setPrompt(`Scanning ${c.species.name}  ${'▮'.repeat(n)}${'▯'.repeat(10 - n)}`);
    if (scanT < SCAN_TIME) return;
    scanDone = true; scanning = false;
    const id = c.species.id;
    if (scanned.has(id)) { flash(`${c.species.name}: already on file.`); return; }
    scanned.add(id);
    audio.play('ui_3', { bus: 'ui', gain: 0.6, rate: 1.2 });
    if (id === 'tuko' || id === 'oomi') tutorial.milestone(id === 'tuko' ? 'scan_tuko' : 'scan_oomi');
    flash(`Scan complete: ${c.species.name}.`);
    recipeCheck?.();
  };

  // --- Unease leaks into the HUD: rare false readings (HUD distortion setting; never during real danger) -------
  let falseTimer = 120 + Math.random() * 120;
  const FALSE_READINGS = ['Life signs: 2', 'Motion detected \u00b7 behind', 'Signal lost', 'Hull integrity: \u2591\u2591\u2591', 'Proximity alert', 'Life signs: 0', 'Unknown transmission'];
  const updateFalseReadings = (dt: number) => {
    if (!settings.hudDistortion || state !== 'playing' || horror.level < 0.55) return;
    if (survival.health < 40 || survival.cold) return; // the readouts that matter stay honest
    if ((falseTimer -= dt * (0.5 + horror.level)) > 0) return;
    falseTimer = 150 + Math.random() * 200;
    flash(FALSE_READINGS[Math.floor(Math.random() * FALSE_READINGS.length)]);
    if (!settings.reduceFlash) { // the health readout stutters for a beat
      const el = $('hpv'), real = el.textContent;
      showGroup(hpGroup, true); el.textContent = String(Math.floor(Math.random() * 99));
      setTimeout(() => { el.textContent = real; }, 180);
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
    // The readout drifts when the core glitches, and slowly wanders as unease rises (HUD distortion setting).
    const wander = settings.hudDistortion ? Math.sin(performance.now() * 0.0004) * Math.sin(performance.now() * 0.00023) * Math.max(0, horror.level - 0.3) * 40 : 0;
    const jitter = (horror.glitch > 0 ? (Math.random() - 0.5) * 60 : 0) + wander;
    const heading = -player.yaw * 180 / Math.PI + jitter;
    TICKS.forEach(([d], i) => place(tickEls[i], d, heading));
    const wreck = tickEls[TICKS.length], fire = tickEls[TICKS.length + 1];
    const dw = player.position.distanceTo(wreckPos.center); // the wreck itself (it lies 9-15 m from the spawn point)
    if (dw > 12) { wreck.textContent = `\u25BC wreck ${Math.round(dw)} m`; place(wreck, bearingTo(wreckPos.center), heading); } else wreck.style.display = 'none';
    let best: THREE.Vector3 | null = null, bd = Infinity;
    for (const f of campfires.list) { const d = f.position.distanceTo(player.position); if (f.lit && d < bd) { bd = d; best = f.position; } }
    if (best && bd > 8) { fire.textContent = `\u25B2 fire ${Math.round(bd)} m`; place(fire, bearingTo(best), heading); } else fire.style.display = 'none';
    // The pack you died with, as the death screen promises (the nearest one could be an old overflow pack).
    const packEl = tickEls[TICKS.length + 2], pk = packs.latestDeath() ?? packs.nearest(player.position);
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
    // The crafting panel doesn't stop the world (unless the setting asks it to): the cold, the night and whatever is
    // out there keep coming while you work.
    const live = state === 'playing' || (state === 'craft' && !settings.pauseCraft);
    updateWrist(dt);
    updateScan(dt);
    chips.update(dt, (x, z) => world.groundAt(x, z));
    const simulating = live || state === 'dead';

    let tm = performance.now();
    world.update(player.position);
    smooth('world', performance.now() - tm);
    player.frozen = !world.isReadyAt(player.position) || state === 'dead';
    // Loaded buried (a save made while clipped into the ground, or after a fill landed on you): lift to the surface.
    if (loadCheck && !player.frozen) {
      loadCheck = false;
      const head = player.position.clone().setY(player.position.y + 0.6);
      if (world.solidAt(head) || world.solidAt(player.position)) {
        const top = world.groundAt(player.position.x, player.position.z);
        if (top) { player.teleport(new THREE.Vector3(player.position.x, top.y + 1.2, player.position.z)); flash('You were stuck in the ground: moved you up to the surface.'); }
      } else if (fauna.blocked?.(player.position.x, player.position.z, 0) && !player.position.equals(spawnPoint)) {
        // ...or inside a mushroom trunk, the wreck or a crate (a mushroom can grow where you saved).
        const dest = openGround(player.position, false);
        if (dest) { player.teleport(dest); flash('You were stuck inside something: moved you to open ground.'); }
      }
    }
    if (simulating) {
      tm = performance.now();
      player.update(dt);
      physics.timestep = Math.max(1 / 240, dt); // dynamic bodies (M2) move at real speed on 60 or 144 Hz screens
      physics.step();
      world.afterPhysics();
      smooth('physics', performance.now() - tm);
      tm = performance.now();
      if (player.position.y < floorY) { // fell out of the world: back on the surface above, not a free trip to the crash site
        const top = world.groundAt(player.position.x, player.position.z);
        player.teleport(top ? new THREE.Vector3(player.position.x, top.y + 1.2, player.position.z) : spawnPoint);
      }

      const wdt = resting ? dt * 6 : dt; // world time while resting
      sky.update(wdt, camera);
      if (live && !player.frozen) {
        survival.update(wdt, { eye: camera.position, sunDir: sky.sunDir, daylight: sky.daylight, roof: (e) => !!world.raycast(e, UP, 40) || wreck.blocks(e, UP, 40), // the wreck shelters you too
          caps: (e, d) => flora.capOver(e, d) || wreck.blocks(e, d, 40),
          blocked: (a, b) => { const d = heatRay.subVectors(b, a), len = d.length(); return len > 1.2 && (world.raycast(a, d.divideScalar(len), len - 0.6) !== null || wreck.blocks(a, d, len - 0.6)); }, ground: (x, z) => world.groundAt(x, z) });
        player.speedMul = survival.moveFactor() * inventory.load_().speed;
        for (const k of inventory.tick(wdt)) flash(`${ITEM_NAMES[k]} has spoiled. You throw it away.`);
        crates.update(wdt);
        placeables.update(wdt, camera.position);
        if (survival.dead) {
          setState('dead');
          audio.death();
          // Materials stay where you fell, in a pack on your compass. Tools and gear come with you, and so does a fire
          // kit: what one campfire costs. (It kept 2 stalkwood, but a fire takes 4 stalkwood and 5 stone, so the kit
          // couldn't build anything and a night death chained straight into the next.)
          const items: Record<string, number> = {};
          const kitFull = inventory.has(CAMPFIRE_COST);
          for (const k of MATERIALS) {
            const keep = Math.min((CAMPFIRE_COST as Partial<Record<ItemId, number>>)[k] ?? 0, inventory.counts[k]);
            if (inventory.counts[k] - keep > 0) items[k] = inventory.counts[k] - keep;
          }
          const dropped = Object.keys(items).length > 0;
          // On the ground at your feet (the body position is the capsule's centre, ~0.9 m up); underground, the cave floor.
          const feet = player.position.clone().setY(player.position.y - 0.9);
          const g = world.groundAt(feet.x, feet.z);
          if (g && Math.abs(g.y - feet.y) < 1.5) feet.y = g.y;
          // Meat keeps its age in the pack (oldest pieces go first, as take() removes them).
          const ages = Object.fromEntries(PERISHABLE.filter((k) => items[k]).map((k) => [k, inventory.ages[k].slice(0, items[k])]));
          if (dropped) { packs.add(feet, items, ages, Date.now()); inventory.take(items as Partial<Record<ItemId, number>>); }
          deathText.textContent = 'You froze.';
          // Wake at the nearest fire you built that will keep burning a while (one about to gutter out only chained
          // the deaths); with none, at the crash site.
          let wake: THREE.Vector3 = spawnPoint, best = Infinity, fire: (typeof campfires.list)[number] | null = null;
          for (const f of campfires.list) {
            const d = f.position.distanceTo(player.position);
            if (f.fuel > 60 && d < best) { best = d; fire = f; }
          }
          if (fire) {
            // Beside it on open ground: a fixed spot 1.6 m east could be inside a crate or trunk, or off a ledge.
            wake = fire.position.clone().add(new THREE.Vector3(1.6, 1.2, 0));
            search: for (const r of [1.8, 2.6, 3.4]) for (let a = 0; a < 8; a++) {
              const x = fire.position.x + Math.cos(a * Math.PI / 4) * r, z = fire.position.z + Math.sin(a * Math.PI / 4) * r;
              const g = world.groundAt(x, z);
              if (!g || g.ny < 0.7 || Math.abs(g.y - fire.position.y) > 1.5 || fauna.blocked?.(x, z, 0.4)) continue;
              wake = new THREE.Vector3(x, g.y + 1.2, z);
              break search;
            }
          }
          const atFire = !!fire;
          deathHint.textContent = dropped ? `Your materials are where you fell, marked on the compass.${kitFull ? ' You kept enough for one campfire.' : ''} Waking ${atFire ? 'at your fire' : 'at the crash site'}\u2026`
            : 'Fire and shelter keep your core temperature up. Cooked meat and a hide wrap help you last the night.';
          deathEl.style.display = 'flex';
          respawnTo = wake.clone(); // a save in the next 3 s (tab closed on the death screen) stores the wake-up, not the corpse
          setTimeout(() => {
            respawnTo = null;
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
      propGlow.value = 0.35 + sky.night * 0.75;
      skyEnv.update(dt, sky.hemi);
      const simDt = hitStop > 0 ? dt * 0.05 : dt;
      hitStop = Math.max(0, hitStop - dt);
      for (let k = pendingHits.length - 1; k >= 0; k--) if ((pendingHits[k].t -= dt) <= 0) { const h = pendingHits.splice(k, 1)[0]; landHit(h.c); }
      fauna.update(simDt, player.position, input.moving && input.down('run') && !player.crouching, player.crouching, sky.night, camera.getWorldDirection(fauna.viewTmp));
      hotbar.update(simDt, input.moving, { yaw: player.yaw, pitch: player.pitch });
      particles.update(simDt);
      updateLamp(dt, fireNearPlayer());
      horror.lampDir = lampOn && lamp.intensity > 1 ? camera.getWorldDirection(new THREE.Vector3()) : null;
      worldSounds(dt);
      if (live) {
        let fireNear = 0;
        for (const f of campfires.list) if (f.lit) fireNear = Math.max(fireNear, 1 - f.position.distanceTo(player.position) / 12);
        const g = world.groundAt(camera.position.x, camera.position.z);
        horror.update({ dt: wdt, camera, night: sky.night, daylight: sky.daylight, fireNear: Math.max(fireNear, placeables.flareNear(player.position) * 0.8), warmth: survival.warmth, health: survival.health,
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
      if (placing && dig && !digBlock) { build(); digBlock = true; } // a click while placing builds instead of digging
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
    fxUniforms.uNight.value = sky.night;
    fxUniforms.uRim.value.setRGB(0.05 * sky.daylight, 0.04 * sky.daylight + 0.07 * sky.night, 0.03 * sky.daylight + 0.065 * sky.night);
    post.update(horror.level, horror.glitch, horror.staticT, sky.daylight, sky.night);
    const fog = scene.fog as THREE.Fog;
    // Hazy even by day (the air here is thick), closing in at night.
    fog.far = CHUNK * VIEW_RADIUS * (0.8 - sky.night * 0.3 - horror.level * 0.15);
    fog.near = fog.far * (0.35 - sky.night * 0.2);
    // Don't draw what the fog hides: the far plane follows the fog (at night ~70% of the loaded area is fogged out).
    const far = Math.min(CHUNK * (VIEW_RADIUS + 1), fog.far + CHUNK * 0.5);
    if (Math.abs(camera.far - far) > 2) { camera.far = far; camera.updateProjectionMatrix(); sky.setRadius(far * 0.9); }
    audio.updateAmbience(dt, sky.night, camera.position.y, camera.position);
    tm = performance.now();
    renderer.info.reset(); // count every pass of the frame for the F3 readout
    if (!wreck.placed) wreck.update(0); // settle it even behind the pause menu (it was missing from the menu backdrop)
    syncHandLights(dt);
    if (renderer.shadowMap.enabled && sky.sun.intensity > 0.02 && ++shadowTick % 3 === 0) renderer.shadowMap.needsUpdate = true; // none in the dusk gap
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
        target = queryTarget(); if (!placing && !scanning) promptEl.textContent = promptFor(target);
        props.settleLogs((x, z) => world.groundAt(x, z));
        const cls = crosshairFor(target);
        if (crossEl.className !== cls) crossEl.className = cls;
      }
      updateVitals();
      updateFalseReadings(0.1);
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
