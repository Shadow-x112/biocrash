# Biocrash item / tool / status icons, rendered from the game's own models (props.glb, viewmodels.glb) plus small
# icon-only models for items that have no world model yet. Cycles, 128 px, transparent, dark-alien lighting
# (cool key, teal rim). Aseprite then pixel-finishes them (art/aseprite/icons.lua): 64 px, shared palette, outline.
# Run: blender -b --factory-startup -P bc_icons.py -- <repo_root>
import bpy, bmesh, math, os, sys, random
from mathutils import Vector, Matrix, noise

ROOT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else r"C:\Users\manri\Documents\biocrash"
RAW = os.path.join(ROOT, "art", "out", "icons_raw"); os.makedirs(RAW, exist_ok=True)
random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene; col = sc.collection
sc.render.engine = "CYCLES"
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for t in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = t; prefs.get_devices()
            for d in prefs.devices: d.use = True
            sc.cycles.device = "GPU"; break
        except Exception: pass
except Exception: pass
sc.cycles.samples = 96; sc.cycles.use_denoising = True
sc.render.resolution_x = sc.render.resolution_y = 128
sc.render.film_transparent = True
sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Medium High Contrast"; sc.view_settings.exposure = 0.6  # icons must read on a dark HUD
sc.world = bpy.data.worlds.new("W"); sc.world.color = (0.004, 0.006, 0.008)


def load(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return {o.name: o for o in bpy.data.objects if o not in before and o.type == "MESH"}


PROPS = load(os.path.join(ROOT, "art", "out", "props2", "props.glb"))
VM = load(os.path.join(ROOT, "art", "out", "vm", "viewmodels.glb"))
for o in list(PROPS.values()) + list(VM.values()):
    o.hide_render = True; o.parent = None


# ---------------------------------------------------------------- materials for icon-only models
def mat(name, base, rough=0.5, metal=0.0, noise_scale=0.0, base2=None, emit=None, emit_strength=0.0, sss=0.0):
    m = bpy.data.materials.new(name); nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if base2 and noise_scale:
        tc = nt.nodes.new("ShaderNodeTexCoord"); nz = nt.nodes.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = noise_scale
        nz.inputs["Detail"].default_value = 8
        nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
        mx = nt.nodes.new("ShaderNodeMix"); mx.data_type = "RGBA"
        mx.inputs[6].default_value = (*base, 1); mx.inputs[7].default_value = (*base2, 1)
        nt.links.new(nz.outputs["Fac"], mx.inputs[0]); nt.links.new(mx.outputs[2], b.inputs["Base Color"])
        bp = nt.nodes.new("ShaderNodeBump"); bp.inputs["Strength"].default_value = 0.4
        nt.links.new(nz.outputs["Fac"], bp.inputs["Height"]); nt.links.new(bp.outputs["Normal"], b.inputs["Normal"])
    else:
        b.inputs["Base Color"].default_value = (*base, 1)
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1); b.inputs["Emission Strength"].default_value = emit_strength
    if sss:
        b.inputs["Subsurface Weight"].default_value = sss
    return m


def obj(name, bm, material):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); col.objects.link(o); me.materials.append(material)
    for p in me.polygons: p.use_smooth = True
    sub = o.modifiers.new("s", "SUBSURF"); sub.levels = sub.render_levels = 2
    o.hide_render = True
    return o


def capsule(a, b, r0, r1, seg=16):
    bm = bmesh.new(); d = b - a
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r0, radius2=r1, depth=d.length)
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4(), verts=bm.verts)
    for r, p in ((r0, a), (r1, b)):
        s = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=8, radius=r); bmesh.ops.translate(bm, verts=s["verts"], vec=p)
    return bm


def merge(bms):
    out = bmesh.new()
    for b in bms:
        tmp = bpy.data.meshes.new("t"); b.to_mesh(tmp); b.free(); out.from_mesh(tmp); bpy.data.meshes.remove(tmp)
    return out


def lumpy(r, sx, sy, sz, amp, seed, sub=3):
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    for v in bm.verts:
        v.co *= 1 + noise.noise(v.co / r * 1.6 + Vector((seed, 0, 0))) * amp
        v.co.x *= sx; v.co.y *= sy; v.co.z *= sz
    return bm


FIBERM = mat("Cord", (0.06, 0.1, 0.06), 0.8, 0, 40, (0.16, 0.24, 0.13))
CHITM = mat("Chitin", (0.02, 0.03, 0.035), 0.22, 0, 12, (0.06, 0.12, 0.12), emit=(0.1, 0.8, 0.65), emit_strength=0.0)
HIDEM = mat("Hide", (0.12, 0.08, 0.09), 0.75, 0, 18, (0.2, 0.14, 0.13))
BONEM = mat("Bone", (0.55, 0.5, 0.42), 0.55, 0, 10, (0.36, 0.32, 0.26))
RAWM = mat("Raw", (0.32, 0.03, 0.05), 0.3, 0, 9, (0.55, 0.14, 0.16), sss=0.2)
COOKM = mat("Cooked", (0.12, 0.05, 0.02), 0.55, 0, 9, (0.3, 0.13, 0.05))
GLOWM = mat("Glow", (0.05, 0.3, 0.26), 0.3, emit=(0.2, 1.0, 0.85), emit_strength=6.0)
REDM = mat("Red", (0.35, 0.03, 0.05), 0.35, 0, 7, (0.6, 0.08, 0.1), emit=(1.0, 0.1, 0.12), emit_strength=0.35, sss=0.3)
FIREM = mat("Fire", (0.6, 0.12, 0.01), 0.4, 0, 6, (0.9, 0.35, 0.02), emit=(1.0, 0.25, 0.02), emit_strength=0.5)
METALM = mat("Metal", (0.18, 0.19, 0.21), 0.35, 0.8, 30, (0.1, 0.1, 0.11))

EXTRA = {}
# Cordage: a coiled hank of twisted fibre cord.
pts = []
bms = []
for i in range(220):
    t = i / 219; a = t * math.tau * 4.2
    r = 0.42 + 0.04 * math.sin(t * 40)
    pts.append(Vector((math.cos(a) * r, math.sin(a) * r, (t - 0.5) * 0.35)))
for a, b in zip(pts, pts[1:]): bms.append(capsule(a, b, 0.07, 0.07, 8))
bms.append(capsule(pts[-1], pts[-1] + Vector((0.5, -0.3, -0.15)), 0.07, 0.05, 8))
EXTRA["cordage"] = obj("cordage", merge(bms), FIBERM)
# Chitin: a curved, glossy shell plate with a glowing seam along its edge.
bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=24, y_segments=16, size=0.6)
for v in bm.verts:
    v.co.z = -(v.co.x ** 2 + (v.co.y * 1.4) ** 2) * 0.9 + noise.noise(v.co * 3) * 0.04
bmesh.ops.delete(bm, geom=[v for v in bm.verts if (v.co.x / 0.6) ** 2 + (v.co.y / 0.42) ** 2 > 1 + noise.noise(v.co * 6) * 0.15], context="VERTS")
bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.06)
EXTRA["chitin"] = obj("chitin", bm, CHITM)
# Hide: a rumpled, folded skin.
bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=30, y_segments=22, size=0.6)
for v in bm.verts:
    v.co.z = noise.noise(v.co * 2.2) * 0.12 + math.sin(v.co.x * 5) * 0.04
    if v.co.x > 0.25: v.co.z += (v.co.x - 0.25) * 1.2  # one edge curling up
bmesh.ops.delete(bm, geom=[v for v in bm.verts if (v.co.x / 0.6) ** 2 + (v.co.y / 0.45) ** 2 > 1 + noise.noise(v.co * 5) * 0.25], context="VERTS")
bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.03)
EXTRA["hide"] = obj("hide", bm, HIDEM)
# Bone: a long bone with knobbed ends.
bms = [capsule(Vector((-0.55, 0, 0)), Vector((0.55, 0, 0)), 0.09, 0.08)]
for x in (-0.6, 0.6):
    for y in (-0.07, 0.07): bms.append(lumpy(0.12, 1, 1, 1, 0.15, x + y, 2)); bmesh.ops.translate(bms[-1], verts=bms[-1].verts, vec=(x, y, 0))
EXTRA["bone"] = obj("bone", merge(bms), BONEM)
# Raw / cooked meat: a lumpy slab with a bone stub.
for key, m_ in (("raw_meat", RAWM), ("cooked_meat", COOKM)):
    bms = [lumpy(0.45, 1.25, 0.8, 0.55, 0.22, 3.0 if key == "raw_meat" else 3.0)]
    bms.append(capsule(Vector((0.35, 0, 0)), Vector((0.78, 0.05, 0.05)), 0.07, 0.06)); bms.append(lumpy(0.1, 1, 1, 1, 0.2, 9, 2))
    bmesh.ops.translate(bms[-1], verts=bms[-1].verts, vec=(0.82, 0.05, 0.05))
    o = obj(key, merge(bms), m_)
    o.data.materials.append(BONEM)
    for p in o.data.polygons:
        if p.center.x > 0.38: p.material_index = 1
    EXTRA[key] = o
# Bone needle: a slender sliver with an eye.
bms = [capsule(Vector((0, 0, -0.6)), Vector((0, 0, 0.6)), 0.045, 0.006)]
tor = bmesh.new(); bmesh.ops.create_cone(tor, cap_ends=False, segments=16, radius1=0.05, radius2=0.05, depth=0.02)
EXTRA["bone_needle"] = obj("bone_needle", merge(bms), BONEM)
# Hide wrap: a rolled bundle of hide tied with cord.
bms = [capsule(Vector((-0.45, 0, 0)), Vector((0.45, 0, 0)), 0.3, 0.3, 24)]
w = obj("hide_wrap", merge(bms), HIDEM)
d = w.modifiers.new("d", "DISPLACE"); d.texture = bpy.data.textures.new("hw", "CLOUDS"); d.texture.noise_scale = 0.15; d.strength = 0.05
tie = obj("hide_wrap_tie", merge([capsule(Vector((x, 0, -0.33)), Vector((x, 0.0, 0.33)), 0.05, 0.05) for x in (-0.15, 0.2)]), FIBERM)
EXTRA["hide_wrap"] = w; w["extra"] = "hide_wrap_tie"
# Chitin spearhead: a glossy leaf-shaped point.
bm = lumpy(0.5, 0.35, 0.09, 1.0, 0.05, 5, 3)
for v in bm.verts:
    t = min(1.0, max(0.0, (v.co.z / 0.5 + 1) / 2))
    v.co.x *= max(0.05, 1 - t ** 1.6); v.co.y *= max(0.2, 1 - t)
EXTRA["chitin_spearhead"] = obj("chitin_spearhead", bm, CHITM)
# Fiber pouch: a small woven sack cinched at the neck with cordage.
bm = lumpy(0.4, 1.0, 0.95, 0.9, 0.08, 11.0, 4)
def _ss(t): t = min(1.0, max(0.0, t)); return t * t * (3 - 2 * t)
for v in bm.verts:  # squeeze the top into a neck, then a ruffled mouth above the tie
    if v.co.z > 0.0:
        t = v.co.z / 0.36
        if t < 0.8:
            k = 1 - 0.68 * _ss(t / 0.8); v.co.z = t * 0.42
        else:
            k = 0.32 + (t - 0.8) * 1.6 + noise.noise(v.co * 9) * 0.06; v.co.z = 0.336 + (t - 0.8) * 0.9
        v.co.x *= k; v.co.y *= k
pouch = obj("fiber_pouch", bm, FIBERM)
d = pouch.modifiers.new("d", "DISPLACE"); d.texture = bpy.data.textures.new("fp", "STUCCI"); d.texture.noise_scale = 0.05; d.strength = 0.03
ring = []
for i in range(40):
    a0 = i / 40 * math.tau; a1 = (i + 1) / 40 * math.tau
    ring.append(capsule(Vector((math.cos(a0) * 0.15, math.sin(a0) * 0.15, 0.33)), Vector((math.cos(a1) * 0.15, math.sin(a1) * 0.15, 0.33)), 0.035, 0.035, 8))
ring.append(capsule(Vector((0.1, -0.12, 0.33)), Vector((0.3, -0.36, 0.0)), 0.03, 0.025, 8))
cinch = obj("fiber_pouch_tie", merge(ring), mat("Tie", (0.42, 0.3, 0.14), 0.7, 0, 20, (0.25, 0.17, 0.08)))
EXTRA["fiber_pouch"] = pouch; pouch["extra"] = "fiber_pouch_tie"
# Hide pack: a stitched hide backpack: fold-over flap, a cord strap across it with a glowing chitin clasp.
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0); bmesh.ops.scale(bm, vec=(0.72, 0.42, 0.86), verts=bm.verts)
bmesh.ops.bevel(bm, geom=bm.edges[:], offset=0.12, segments=3, affect="EDGES")
hpack = obj("hide_pack", bm, HIDEM)
d = hpack.modifiers.new("d", "DISPLACE"); d.texture = bpy.data.textures.new("hp", "CLOUDS"); d.texture.noise_scale = 0.18; d.strength = 0.04
fl = bmesh.new(); bmesh.ops.create_grid(fl, x_segments=16, y_segments=10, size=0.5)
for v in fl.verts:  # the flap drapes over the top and down the front, with a ragged hem
    u = (v.co.x / 0.5) * 0.4; w = (v.co.y / 0.5 + 1) / 2
    if w < 0.45: v.co = Vector((u, -0.235, 0.44 - (0.45 - w) * 1.05 + noise.noise(Vector((u * 8, 0, 1))) * 0.03 * (w < 0.06)))
    else: v.co = Vector((u, -0.235 + (w - 0.45) * 0.85, 0.44 + math.sin((w - 0.45) / 0.55 * math.pi) * 0.05 - (u / 0.4) ** 2 * 0.03))
bmesh.ops.solidify(fl, geom=fl.faces[:], thickness=0.035); bmesh.ops.recalc_face_normals(fl, faces=fl.faces[:])
flap = obj("hide_pack_flap", fl, mat("HideFlap", (0.1, 0.045, 0.02), 0.85, 0, 22, (0.2, 0.1, 0.04)))
flap["keep_loc"] = 1
straps = [capsule(Vector((-0.38, -0.27, 0.05)), Vector((0.38, -0.27, 0.05)), 0.03, 0.03, 8)]  # band across the flap
for x in (-0.37, 0.37): straps.append(capsule(Vector((x, -0.23, 0.44)), Vector((x, -0.23, -0.3)), 0.03, 0.03, 8))  # side cords
straps.append(lumpy(0.075, 1, 0.45, 1, 0.12, 13, 2)); bmesh.ops.translate(straps[-1], verts=straps[-1].verts, vec=(0, -0.3, 0.05))
hs = obj("hide_pack_straps", merge(straps), FIBERM)
hs.data.materials.append(GLOWM)
for p in hs.data.polygons:
    if p.center.y < -0.29 and abs(p.center.x) < 0.09: p.material_index = 1
EXTRA["hide_pack"] = hpack; hpack["extra"] = "hide_pack_straps"; hpack["extra2"] = "hide_pack_flap"
# Status icons: a glowing heart-organ (health), a flame (body heat), the wrist lamp (lamp).
bm = lumpy(0.45, 1.0, 0.7, 1.05, 0.12, 2.0)
for v in bm.verts:  # heart-ish: a cleft on top, tapered bottom
    if v.co.z > 0.25: v.co.z -= max(0.0, 0.18 - abs(v.co.x) * 0.6)
    if v.co.z < 0: v.co.x *= 1 + v.co.z * 0.9
EXTRA["st_health"] = obj("st_health", bm, REDM)
bm = lumpy(0.4, 0.7, 0.7, 1.3, 0.1, 4.0)
for v in bm.verts:
    t = min(1.0, max(0.0, (v.co.z / 0.52 + 1) / 2))
    v.co.x *= max(0.05, 1 - t ** 1.3); v.co.y *= max(0.05, 1 - t ** 1.3)
    v.co.x += math.sin(t * 5) * 0.08 * t
EXTRA["st_heat"] = obj("st_heat", bm, FIREM)
core = lumpy(0.22, 0.7, 0.7, 1.2, 0.08, 6.0)
for v in core.verts:
    t = min(1.0, max(0.0, (v.co.z / 0.27 + 1) / 2)); v.co.x *= max(0.05, 1 - t ** 1.2); v.co.y *= max(0.05, 1 - t ** 1.2)
core_o = obj("st_heat_core", core, mat("Core", (1.0, 0.7, 0.15), 0.3, emit=(1.0, 0.62, 0.1), emit_strength=1.4))
core_o.location = (0, -0.25, -0.12); EXTRA["st_heat"]["extra"] = "st_heat_core"
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0); bmesh.ops.scale(bm, vec=(0.7, 1.0, 0.4), verts=bm.verts)
lamp = obj("st_lamp", bm, METALM)
lamp.modifiers["s"].levels = lamp.modifiers["s"].render_levels = 1
bv = lamp.modifiers.new("b", "BEVEL"); bv.width = 0.08; bv.segments = 3; lamp.modifiers.move(1, 0)
lens = obj("st_lamp_lens", lumpy(0.22, 1, 0.3, 1, 0.0, 1, 3), GLOWM); lens.location = (0, -0.5, 0.0)
EXTRA["st_lamp"] = lamp; lamp["extra"] = "st_lamp_lens"

# ---------------------------------------------------------------- lights and camera
def light(name, kind, energy, color, loc, size=1.0):
    l = bpy.data.lights.new(name, kind); l.energy = energy; l.color = color
    if kind == "AREA": l.size = size
    o = bpy.data.objects.new(name, l); col.objects.link(o); o.location = loc
    o.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return o
light("Key", "AREA", 800, (0.85, 0.92, 1.0), (2.5, -3.0, 3.5), 2.5)
light("Rim", "AREA", 160, (0.3, 1.0, 0.85), (-3.0, 3.0, 1.5), 2.0)
light("Fill", "AREA", 160, (0.6, 0.5, 0.8), (-2.5, -3.0, -0.5), 3.0)
camd = bpy.data.cameras.new("Cam"); camd.type = "ORTHO"; cam = bpy.data.objects.new("Cam", camd); col.objects.link(cam); sc.camera = cam
VIEW = Vector((0.55, -1.0, 0.7)).normalized()


def shoot(name, objs, rot=(0, 0, 0), out=None, pad=1.12, zoom=1.0, shift=(0.0, 0.0), focus=None):
    for o in objs:
        o.hide_render = False
        o.rotation_mode = "XYZ"; o.rotation_euler = [math.radians(a) for a in rot]
        o.location = (0, 0, 0) if not o.get("keep_loc") else o.location
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    c = (lo + hi) / 2
    cam.location = c + VIEW * 10
    cam.rotation_euler = (-VIEW).to_track_quat("-Z", "Y").to_euler()
    bpy.context.view_layer.update()
    # Fit: project the corners onto the camera plane.
    inv = cam.matrix_world.inverted()
    pc = [inv @ p for p in pts]
    w = max(p.x for p in pc) - min(p.x for p in pc); h = max(p.y for p in pc) - min(p.y for p in pc)
    camd.ortho_scale = max(w, h) * pad * zoom
    cx = (max(p.x for p in pc) + min(p.x for p in pc)) / 2 + shift[0] * w; cy = (max(p.y for p in pc) + min(p.y for p in pc)) / 2 + shift[1] * h
    if focus is not None:
        fp = inv @ focus; cx, cy = fp.x, fp.y
    cam.location = cam.matrix_world @ Vector((cx, cy, 0))
    sc.render.filepath = os.path.join(RAW, (out or name) + ".png")
    bpy.ops.render.render(write_still=True)
    for o in objs: o.hide_render = True
    print("icon", name)


def with_extra(o):
    return [o] + [bpy.data.objects[o[k]] for k in ("extra", "extra2") if o.get(k)]


for o in EXTRA.values():
    for k in ("extra", "extra2"):
        if o.get(k): bpy.data.objects[o[k]]["keep_loc"] = 1

# Items from the game's own models.
shoot("stone", [PROPS["Stone"]], (0, 0, 20))
shoot("stalkwood", [PROPS["Stalkwood"]], (0, 50, 30))
shoot("fiber", [PROPS["Fiber"]], (0, 0, 0), pad=0.9)
# Tools: diagonal, head up and to the right.
shoot("stone_pick", [VM["Tool_Pick"]], (0, -40, 0))
shoot("stone_knife", [VM["Tool_Knife"]], (0, -40, 0))
# Spear: frame the stone point end (the wider end of the long axis), not the whole shaft.
sp = VM["Tool_Spear"]; sp.rotation_mode = "XYZ"; sp.rotation_euler = [math.radians(a) for a in (60, -38, 0)]; sp.location = (0, 0, 0)
bpy.context.view_layer.update()
vs = [sp.matrix_world @ v.co for v in sp.data.vertices]
lo_ = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs))); hi_ = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
ax = max(range(3), key=lambda i: hi_[i] - lo_[i]); L = hi_[ax] - lo_[ax]
def girth(end):
    sel = [v for v in vs if (v[ax] - lo_[ax] < L * 0.12) == (end == 0)] if end == 0 else [v for v in vs if hi_[ax] - v[ax] < L * 0.12]
    c = sum(sel, Vector()) / len(sel); return max((v - c).length for v in sel), c
g0, c0 = girth(0); g1, c1 = girth(1)
grip = sp.matrix_world @ Vector((0.0, 0.14, -0.09))  # the hand grip (viewmodel space): the point is the far end
tip = c1 if (c1 - grip).length > (c0 - grip).length else c0
shoot("spear", [sp], (60, -38, 0), zoom=0.75, focus=tip)
shoot("hands", [VM["Hand_Open"]], (0, 0, 0))
for k in ("cordage", "chitin", "hide", "bone", "raw_meat", "cooked_meat", "bone_needle", "hide_wrap", "chitin_spearhead", "fiber_pouch", "hide_pack", "st_health", "st_heat", "st_lamp"):
    rot = {"cordage": (20, 0, 0), "bone": (0, -35, 20), "bone_needle": (0, -45, 0), "chitin_spearhead": (0, -45, 0),
           "hide_wrap": (0, -20, 25), "chitin": (25, 0, 15), "raw_meat": (10, -15, 20), "cooked_meat": (10, -15, 20), "fiber_pouch": (0, 0, 25), "hide_pack": (-12, 0, 38)}.get(k, (0, 0, 0))
    shoot(k, with_extra(EXTRA[k]), rot)
print("@@DONE@@", sorted(os.listdir(RAW)))
