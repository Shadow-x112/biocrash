# Biocrash creatures: Tuko (small armoured six-legged grazer that curls into a ball) and Oomi (tall tripod grazer),
# rigged and animated, plus the horror Figure (static silhouette). One glTF: two armatures with skinned meshes and
# their clips (Tuko_Idle/Walk/Run/Curl/Death, Oomi_Idle/Walk/Run/Sleep/Death) and a Figure mesh.
# Facing: Blender -Y (= +Z in three.js). Colour (and glow, via bright vertex colours) is per vertex.
# Run: blender -b --factory-startup -P bc_creatures.py -- <out_dir> [bake_size]
# V2: fused voxel-remeshed skins with baked 2K PBR + emission maps (see V2 SKIN PIPELINE).
import bpy, bmesh, math, random, os, sys
from mathutils import Vector, Quaternion, Matrix, noise

random.seed(3)
OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else r"C:\Users\manri\OneDrive\AssetLibrary\3D\Creatures\bc_creatures"
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 24
col = scene.collection

MAT = bpy.data.materials.new("Creature")
_b = MAT.node_tree.nodes["Principled BSDF"]
_b.inputs["Roughness"].default_value = 0.42
_vc = MAT.node_tree.nodes.new("ShaderNodeVertexColor"); _vc.layer_name = "Col"
MAT.node_tree.links.new(_vc.outputs["Color"], _b.inputs["Base Color"])

CHITIN = (0.085, 0.10, 0.105); BELLY = (0.24, 0.17, 0.14); GLOW = (0.3, 1.0, 0.85); SKIN = (0.17, 0.12, 0.17); DARK = (0.06, 0.05, 0.07)


def gritty(c, co, k=0.25):
    n = noise.noise(co * 18) * k + noise.noise(co * 5) * k * 0.6
    return (max(0, c[0] * (1 + n)), max(0, c[1] * (1 + n)), max(0, c[2] * (1 + n)), 1.0)


class Builder:
    """Collects rigid parts, each bound to one bone, into one skinned mesh."""
    def __init__(self, name, pfx):
        self.bm = bmesh.new(); self.name = name; self.pfx = pfx
        self.col = self.bm.loops.layers.color.new("Col")
        self.dl = self.bm.verts.layers.deform.verify()
        self.groups = []

    def add(self, part_bm, bone, color, matrix=Matrix.Identity(4), grit=0.25):
        bone = self.pfx + bone
        if bone not in self.groups: self.groups.append(bone)
        gi = self.groups.index(bone)
        part_bm.transform(matrix)
        tmp = bpy.data.meshes.new("t"); part_bm.to_mesh(tmp); part_bm.free()
        before = set(self.bm.verts)
        self.bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)
        self.bm.verts.ensure_lookup_table()
        new = [v for v in self.bm.verts if v not in before]
        newset = set(new)
        for v in new: v[self.dl][gi] = 1.0
        for f in self.bm.faces:
            if f.verts[0] in newset:
                for l in f.loops:
                    l[self.col] = color(l.vert.co) if callable(color) else gritty(color, l.vert.co, grit)

    def finish(self, arm):
        me = bpy.data.meshes.new(self.name); self.bm.to_mesh(me); self.bm.free()
        o = bpy.data.objects.new(self.name, me); col.objects.link(o)
        for g in self.groups: o.vertex_groups.new(name=g)
        me.materials.append(MAT)
        for p in me.polygons: p.use_smooth = True
        o["arm"] = arm.name
        return o


def ellipsoid(r, sx=1, sy=1, sz=1, seg=16, ring=10, half=False):
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=ring, radius=r)
    if half:
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -r * 0.05], context="VERTS")
    for v in bm.verts: v.co.x *= sx; v.co.y *= sy; v.co.z *= sz
    return bm


def capsule(a, b, r0, r1, seg=10):
    """Tapered tube from a to b (closed)."""
    bm = bmesh.new()
    d = (b - a); L = d.length
    m = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r0, radius2=r1, depth=L)
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4(), verts=bm.verts)
    return bm


PFX = {}
def make_armature(name, bones, pfx):
    """bones: list of (name, head, tail, parent). Bone names get a per-species prefix so clips never cross rigs."""
    ad = bpy.data.armatures.new(name); arm = bpy.data.objects.new(name, ad); col.objects.link(arm)
    PFX[name] = pfx
    bones = [(pfx + n, h, t, (pfx + p) if p else None) for n, h, t, p in bones]
    bpy.context.view_layer.objects.active = arm; arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for n, h, t, p in bones:
        eb = ad.edit_bones.new(n); eb.head = h; eb.tail = t; eb.roll = 0
        if p: eb.parent = ad.edit_bones[p]; eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def rot(arm, bone, axis, ang):
    """Rotation about an armature-space axis, written into the bone's local pose (robust to bone roll)."""
    bone = PFX[arm.name] + bone
    pb = arm.pose.bones[bone]
    ml = arm.data.bones[bone].matrix_local.to_quaternion()
    q = ml.inverted() @ Quaternion(Vector(axis).normalized(), ang) @ ml
    pb.rotation_mode = "QUATERNION"
    pb.rotation_quaternion = q @ pb.rotation_quaternion


def clip(arm, name, frames, pose_fn, loop=True):
    act = bpy.data.actions.new(name); act.use_fake_user = True
    arm.animation_data_create(); arm.animation_data.action = act
    keys = list(range(0, frames + 1, 2)) if loop else list(range(0, frames + 1, 2))
    for f in keys:
        t = f / frames
        for pb in arm.pose.bones:
            pb.rotation_mode = "QUATERNION"; pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0)
        pose_fn(t)
        for pb in arm.pose.bones:
            pb.keyframe_insert("rotation_quaternion", frame=f); pb.keyframe_insert("location", frame=f)
    slot = arm.animation_data.action_slot
    arm.animation_data.action = None
    # One NLA track per clip: the glTF exporter turns each track into a named animation.
    tr = arm.animation_data.nla_tracks.new(); tr.name = name
    st = tr.strips.new(name, 0, act)
    try:
        if slot is not None: st.action_slot = slot
    except Exception: pass
    tr.mute = True
    return act


# =====================================================================================================
# TUKO: ~0.55 m long. Three armoured segments with glowing seams, a lensed head, six jointed legs.
tb = [("root", (0, 0, 0), (0, 0, 0.08), None),
      ("seg3", (0, 0.2, 0.15), (0, 0.07, 0.16), "root"),
      ("seg2", (0, 0.07, 0.16), (0, -0.06, 0.16), "seg3"),
      ("seg1", (0, -0.06, 0.16), (0, -0.18, 0.15), "seg2"),
      ("head", (0, -0.18, 0.15), (0, -0.27, 0.13), "seg1")]
LEGS = []
for si, (seg, y) in enumerate([("seg1", -0.12), ("seg2", 0.0), ("seg3", 0.12)]):
    for side, sx in (("L", 1), ("R", -1)):
        u, l = f"leg{si}{side}_u", f"leg{si}{side}_l"
        tb.append((u, (sx * 0.09, y, 0.13), (sx * 0.2, y - 0.01, 0.13), seg))
        tb.append((l, (sx * 0.2, y - 0.01, 0.13), (sx * 0.25, y - 0.02, 0.0), u))
        LEGS.append((u, l, sx, si))
tuko = make_armature("Tuko", tb, "t_")
B = Builder("Tuko_Body", "t_")
for seg, (y0, y1), r in [("seg3", (0.2, 0.07), 0.13), ("seg2", (0.07, -0.06), 0.14), ("seg1", (-0.06, -0.18), 0.13)]:
    yc = (y0 + y1) / 2
    B.add(ellipsoid(r, 1.05, 0.72, 0.85, half=True), seg, CHITIN, Matrix.Translation((0, yc, 0.12)))           # plate
    B.add(ellipsoid(r * 0.9, 1.0, 0.8, 0.35), seg, BELLY, Matrix.Translation((0, yc, 0.12)))                 # belly
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=False, segments=24, radius1=r * 1.02, radius2=r * 1.02, depth=0.008)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.y < -r * 0.2], context="VERTS")
    B.add(bm, seg, GLOW, Matrix.Translation((0, y1 + 0.003, 0.12)) @ Matrix.Rotation(math.radians(90), 4, "X"), grit=0)  # glowing seam
B.add(ellipsoid(0.085, 1.0, 1.15, 0.75), "head", CHITIN, Matrix.Translation((0, -0.22, 0.13)))
for x in (-0.04, 0.04):
    B.add(ellipsoid(0.022, seg=8, ring=6), "head", GLOW, Matrix.Translation((x, -0.29, 0.15)), grit=0)
for (u, l, sx, si) in LEGS:
    ub = tuko.data.bones["t_" + u]; lb = tuko.data.bones["t_" + l]
    B.add(capsule(ub.head_local, ub.tail_local, 0.018, 0.013), u, BELLY)
    B.add(capsule(lb.head_local, lb.tail_local, 0.013, 0.005), l, CHITIN)
for seg, yc, r in [("seg3", 0.135, 0.13), ("seg2", 0.005, 0.14), ("seg1", -0.12, 0.13)]:   # dorsal spines + side barbs
    top = 0.12 + r * 0.85 * 0.98
    B.add(capsule(Vector((0, yc + 0.02, top - 0.01)), Vector((0, yc + 0.055, top + 0.05)), 0.016, 0.003, 8), seg, DARK)
    for sx in (-1, 1):
        B.add(capsule(Vector((sx * r * 0.8, yc, 0.17)), Vector((sx * (r + 0.05), yc + 0.03, 0.16)), 0.012, 0.003, 8), seg, DARK)
for sx in (-1, 1):  # mandibles and antennae
    B.add(capsule(Vector((sx * 0.035, -0.27, 0.11)), Vector((sx * 0.012, -0.33, 0.085)), 0.012, 0.004, 8), "head", DARK)
    B.add(capsule(Vector((sx * 0.03, -0.27, 0.17)), Vector((sx * 0.09, -0.4, 0.27)), 0.007, 0.004, 8), "head", CHITIN)
    B.add(ellipsoid(0.009, seg=8, ring=6), "head", GLOW, Matrix.Translation((sx * 0.09, -0.4, 0.27)), grit=0)
TUKO_SRC = B.finish(tuko)

def tuko_walk(speed):
    def f(t):
        for (u, l, sx, si) in LEGS:
            ph = t * math.tau + (0 if (si + (sx > 0)) % 2 == 0 else math.pi)  # alternating tripods
            rot(tuko, u, (0, 0, 1), math.sin(ph) * 0.45 * speed * sx)
            rot(tuko, u, (0, 1, 0), max(0, math.cos(ph)) * 0.35 * speed * sx)
        tuko.pose.bones["t_root"].location = (0, 0, 0)
        rot(tuko, "seg2", (0, 1, 0), math.sin(t * math.tau * 2) * 0.05 * speed)
        rot(tuko, "head", (0, 0, 1), math.sin(t * math.tau) * 0.12)
    return f
def tuko_idle(t):
    rot(tuko, "head", (0, 0, 1), math.sin(t * math.tau) * 0.25)
    rot(tuko, "head", (1, 0, 0), math.sin(t * math.tau * 2) * 0.08)
    for (u, l, sx, si) in LEGS: rot(tuko, l, (0, 1, 0), math.sin(t * math.tau + si) * 0.04 * sx)
def tuko_curl(t):
    k = min(1, t * 1.2) ** 0.8
    rot(tuko, "seg2", (1, 0, 0), -0.9 * k); rot(tuko, "seg1", (1, 0, 0), -1.1 * k); rot(tuko, "head", (1, 0, 0), -1.2 * k)
    rot(tuko, "seg3", (1, 0, 0), 0.8 * k)
    for (u, l, sx, si) in LEGS:
        rot(tuko, u, (0, 1, 0), -1.0 * k * sx); rot(tuko, l, (0, 1, 0), -1.2 * k * sx)
def tuko_death(t):
    k = min(1, t * 1.5)
    rot(tuko, "root", (0, 1, 0), math.pi * 0.95 * k)
    tuko.pose.bones["t_root"].location = (0, 0, 0.12 * math.sin(k * math.pi) + 0.18 * k)
    for (u, l, sx, si) in LEGS:
        tw = math.sin(t * 40 + si) * (1 - k) * 0.3
        rot(tuko, u, (0, 1, 0), (-0.6 * k + tw) * sx); rot(tuko, l, (0, 1, 0), -1.0 * k * sx)
clip(tuko, "Tuko_Idle", 48, tuko_idle)
clip(tuko, "Tuko_Walk", 16, tuko_walk(1.0))
clip(tuko, "Tuko_Run", 10, tuko_walk(1.6))
clip(tuko, "Tuko_Curl", 12, tuko_curl, loop=False)
clip(tuko, "Tuko_Death", 18, tuko_death, loop=False)

# =====================================================================================================
# OOMI: a 2 m tripod grazer. Leathery body with glowing pores and dorsal spines, a long neck, a lensed head.
OX = 3.0  # built off to the side so the two rigs don't overlap in the file
ob = [("root", (OX, 0, 0), (OX, 0, 0.2), None),
      ("body", (OX, 0.25, 1.0), (OX, -0.3, 1.05), "root"),
      ("neck1", (OX, -0.35, 1.1), (OX, -0.5, 1.35), "body"),
      ("neck2", (OX, -0.5, 1.35), (OX, -0.62, 1.55), "neck1"),
      ("head", (OX, -0.62, 1.55), (OX, -0.9, 1.58), "neck2")]
OLEGS = [("legF", (OX, -0.3, 0.92), (OX, -0.42, 0.5), (OX, -0.38, 0.0)),
         ("legL", (OX + 0.28, 0.3, 0.92), (OX + 0.46, 0.4, 0.5), (OX + 0.42, 0.36, 0.0)),
         ("legR", (OX - 0.28, 0.3, 0.92), (OX - 0.46, 0.4, 0.5), (OX - 0.42, 0.36, 0.0))]
for n, a, k, f in OLEGS:
    ob.append((n + "_u", a, k, "body")); ob.append((n + "_l", k, f, n + "_u"))
oomi = make_armature("Oomi", ob, "o_")
B = Builder("Oomi_Body", "o_")
def pores(co):
    v = noise.noise(co * 7.0)
    return (0.35, 1.0, 0.9, 1) if (v > 0.42 and co.z > 1.05) else gritty(SKIN, co, 0.3)
B.add(ellipsoid(0.45, 0.95, 1.25, 0.72, seg=28, ring=18), "body", pores, Matrix.Translation((OX, 0.0, 1.0)))
for i in range(7):  # dorsal spines
    y = 0.3 - i * 0.1
    B.add(capsule(Vector((OX, y, 1.28 - abs(i - 3) * 0.02)), Vector((OX, y + 0.06, 1.42 - abs(i - 3) * 0.03)), 0.03, 0.004, seg=6), "body", DARK)
b1 = oomi.data.bones["o_neck1"]; b2 = oomi.data.bones["o_neck2"]
B.add(capsule(b1.head_local, b1.tail_local, 0.12, 0.09, 12), "neck1", SKIN)
B.add(capsule(b2.head_local, b2.tail_local, 0.09, 0.075, 12), "neck2", SKIN)
B.add(ellipsoid(0.13, 0.85, 1.6, 0.75), "head", SKIN, Matrix.Translation((OX, -0.76, 1.57)))
B.add(ellipsoid(0.05, seg=10, ring=8), "head", GLOW, Matrix.Translation((OX, -0.95, 1.6)), grit=0)
for n, a, k, f in OLEGS:
    B.add(capsule(Vector(a), Vector(k), 0.075, 0.05, 10), n + "_u", SKIN)
    B.add(capsule(Vector(k), Vector(f), 0.05, 0.025, 10), n + "_l", DARK)
    B.add(ellipsoid(0.06, 1, 1, 0.6, seg=10, ring=6), n + "_l", DARK, Matrix.Translation(Vector(k)))
for i, (dx, dz) in enumerate([(-0.045, 0.0), (0.045, 0.0), (-0.02, -0.03), (0.02, -0.03)]):  # mouth tendrils
    a = Vector((OX + dx, -0.86, 1.53 + dz)); b = a + Vector((dx * 1.5, -0.06, -0.22 - i * 0.03))
    B.add(capsule(a, b, 0.02, 0.008, 8), "head", DARK)
    B.add(ellipsoid(0.012, seg=8, ring=6), "head", GLOW, Matrix.Translation(b), grit=0)
for dx in (-0.06, 0.06):  # side eyes
    B.add(ellipsoid(0.028, seg=10, ring=8), "head", GLOW, Matrix.Translation((OX + dx, -0.86, 1.63)), grit=0)
OOMI_SRC = B.finish(oomi)

def oomi_walk(speed):
    def f(t):
        for i, (n, a, k, ft) in enumerate(OLEGS):
            ph = t * math.tau + i * math.tau / 3
            rot(oomi, n + "_u", (1, 0, 0), math.sin(ph) * 0.35 * speed)
            # The knee lifts the foot while it swings forward (foot moves forward as sin(ph) falls). It lifted on the
            # backstroke, so planted feet slid forward: the Oomi moonwalked.
            rot(oomi, n + "_l", (1, 0, 0), -max(0, -math.cos(ph)) * 0.55 * speed)
        oomi.pose.bones["o_body"].location = (0, 0, 0)
        rot(oomi, "body", (0, 1, 0), math.sin(t * math.tau) * 0.05 * speed)
        rot(oomi, "neck1", (1, 0, 0), math.sin(t * math.tau * 2) * 0.06 * speed)
        rot(oomi, "head", (0, 0, 1), math.sin(t * math.tau) * 0.1)
    return f
def oomi_idle(t):
    rot(oomi, "neck1", (1, 0, 0), math.sin(t * math.tau) * 0.08 - 0.05)
    rot(oomi, "neck2", (0, 0, 1), math.sin(t * math.tau) * 0.15)
    rot(oomi, "head", (1, 0, 0), math.sin(t * math.tau * 2) * 0.1)
def oomi_sleep(t):
    k = min(1, t * 1.3)
    root = oomi.pose.bones["o_root"]; root.location = (0, 0, -0.42 * k)
    for n, a, kk, f in OLEGS:
        out = 1 if n == "legL" else -1 if n == "legR" else 0
        rot(oomi, n + "_u", (1, 0, 0), (0.9 if n == "legF" else -0.9) * k)
        rot(oomi, n + "_u", (0, 1, 0), 0.5 * out * k)
        rot(oomi, n + "_l", (1, 0, 0), (-1.6 if n == "legF" else 1.6) * k)
    rot(oomi, "neck1", (1, 0, 0), 0.6 * k); rot(oomi, "neck2", (1, 0, 0), 0.7 * k); rot(oomi, "head", (1, 0, 0), 0.4 * k)
def oomi_death(t):
    k = min(1, t * 1.4) ** 1.5
    rot(oomi, "root", (0, 1, 0), math.pi / 2 * 0.95 * k)
    oomi.pose.bones["o_root"].location = (0, 0, 0.35 * k)
    rot(oomi, "neck1", (1, 0, 0), 0.5 * k); rot(oomi, "head", (1, 0, 0), 0.6 * k)
    for n, a, kk, f in OLEGS: rot(oomi, n + "_l", (1, 0, 0), -0.7 * k)
clip(oomi, "Oomi_Idle", 72, oomi_idle)
clip(oomi, "Oomi_Walk", 36, oomi_walk(1.0))
clip(oomi, "Oomi_Run", 18, oomi_walk(1.7))
clip(oomi, "Oomi_Sleep", 30, oomi_sleep, loop=False)
clip(oomi, "Oomi_Death", 30, oomi_death, loop=False)

# =====================================================================================================
# FIGURE: 2.6 m, gaunt, too-long arms, shoulders hunched, head tilted. Static (the game keeps it utterly still).
bm = bmesh.new()
def add(b2):
    tmp = bpy.data.meshes.new("t"); b2.to_mesh(tmp); b2.free(); bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)
FX = -3.0
def addt(b2, m=Matrix.Identity(4)):
    b2.transform(m); add(b2)
V = lambda x, y, z: Vector((FX + x, y, z))
def E(r, pos, sx=1, sy=1, sz=1, rx=0.0, ry=0.0):
    addt(ellipsoid(r, sx, sy, sz, seg=16, ring=12), Matrix.Translation(V(*pos)) @ Matrix.Rotation(ry, 4, "Y") @ Matrix.Rotation(rx, 4, "X"))
for sx in (-1, 1):  # legs: bony knees, splayed slightly, feet long
    E(0.05, (sx * 0.12, -0.06, 0.03), 1, 2.4, 0.6)
    add(capsule(V(sx * 0.12, 0.0, 0.04), V(sx * 0.105, 0.04, 0.64), 0.04, 0.05))
    E(0.062, (sx * 0.105, 0.025, 0.65))
    add(capsule(V(sx * 0.105, 0.03, 0.65), V(sx * 0.085, 0.0, 1.2), 0.055, 0.085))
E(0.15, (0, 0.01, 1.21), 1.15, 0.75, 0.7)                                   # pelvis
add(capsule(V(0, 0.03, 1.2), V(0, 0.06, 1.6), 0.075, 0.07))                # starved waist
E(0.2, (0, 0.03, 1.79), 0.95, 0.66, 1.12, rx=0.2)                          # ribcage, hunched forward
for sx in (-1, 1):
    E(0.068, (sx * 0.22, 0.08, 2.02))                                       # shoulder knobs
    E(0.065, (sx * 0.1, 0.17, 1.93), 1, 0.45, 1.2)                          # shoulder blades
add(capsule(V(-0.22, 0.06, 2.03), V(0.22, 0.06, 2.03), 0.04, 0.04))        # clavicles
add(capsule(V(0, 0.07, 2.0), V(0.035, -0.08, 2.3), 0.05, 0.038))            # neck, craning forward
E(0.13, (0.06, -0.14, 2.43), 0.72, 1.0, 1.5, ry=0.35)                      # long head, tilted
E(0.07, (0.075, -0.21, 2.27), 0.8, 1.0, 1.5, ry=0.35)                      # jaw hanging long
for sx in (-1, 1):  # arms that reach the knees
    x0 = sx * 0.22
    add(capsule(V(x0, 0.08, 2.0), V(x0 + sx * 0.05, 0.1, 1.45), 0.045, 0.034))
    E(0.044, (x0 + sx * 0.05, 0.1, 1.44))
    add(capsule(V(x0 + sx * 0.05, 0.1, 1.44), V(x0 + sx * 0.04, -0.02, 0.86), 0.034, 0.024))
    E(0.036, (x0 + sx * 0.04, -0.03, 0.79), 0.55, 0.7, 1.7)
    for k in range(4):
        add(capsule(V(x0 + sx * 0.04, -0.03 - k * 0.012, 0.74), V(x0 + sx * (0.0 + k * 0.025), -0.06 - k * 0.018, 0.4 + abs(k - 1.5) * 0.03), 0.011, 0.007, 8))
for k in range(5):  # ribs pressing through the skin, and spine knobs
    z = 1.98 - k * 0.1; w = 0.16 - k * 0.012
    for sx in (-1, 1):
        add(capsule(Vector((FX + 0.01, 0.12, z)), Vector((FX + 0.01 + sx * w, -0.02, z - 0.06)), 0.018, 0.012, 8))
for k in range(9):
    addt(ellipsoid(0.03, seg=8, ring=6), Matrix.Translation((FX, 0.16 + 0.01 * math.sin(k), 2.08 - k * 0.1)))
fig_me = bpy.data.meshes.new("FigureSrc"); bm.to_mesh(fig_me); bm.free()
fig_src = bpy.data.objects.new("FigureSrc", fig_me); col.objects.link(fig_src)
fig_src.location.x -= FX

# =====================================================================================================
# V2 SKIN PIPELINE. Each creature's rigid parts (the "src" mesh, one bone per part) are fused into one
# watertight organic skin (voxel remesh + smoothing + displacement), decimated into the game mesh, UV-unwrapped,
# and baked: normal (high skin incl. procedural chitin/wrinkle bump), base colour, roughness and emission (src
# colours + procedural grit, veins and pores). Weights come from the src parts by nearest-surface transfer.
BAKE = int(sys.argv[sys.argv.index("--") + 2]) if "--" in sys.argv and len(sys.argv) > sys.argv.index("--") + 2 else 2048


def ctx(o, sel=None):
    return bpy.context.temp_override(object=o, active_object=o, selected_objects=sel or [o], selected_editable_objects=sel or [o])


def apply_all(o):
    with ctx(o):
        for m in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)


def copy_obj(o, name):
    c = o.copy(); c.data = o.data.copy(); c.name = name; c.data.name = name; col.objects.link(c)
    return c


def tex(kind, name, size, **kw):
    t = bpy.data.textures.new(name, kind); t.noise_scale = size
    for k, v in kw.items(): setattr(t, k, v)
    return t


def make_skin(src, name, voxel, smooth_it, disp, low_faces):
    hi = copy_obj(src, name + "_High")
    hi.vertex_groups.clear()
    m = hi.modifiers.new("rm", "REMESH"); m.mode = "VOXEL"; m.voxel_size = voxel; m.adaptivity = 0
    s = hi.modifiers.new("sm", "SMOOTH"); s.factor = 0.6; s.iterations = smooth_it
    for i, (size, strength) in enumerate(disp):
        d = hi.modifiers.new(f"d{i}", "DISPLACE"); d.texture = tex("VORONOI" if i == 0 else "CLOUDS", f"{name}_t{i}", size)
        d.texture_coords = "OBJECT" if False else "LOCAL"; d.strength = strength; d.mid_level = 0.5
    apply_all(hi)
    for p in hi.data.polygons: p.use_smooth = True
    lo = copy_obj(hi, name)
    dm = lo.modifiers.new("dec", "DECIMATE"); dm.ratio = min(1.0, low_faces / max(1, len(lo.data.polygons)))
    apply_all(lo)
    for p in lo.data.polygons: p.use_smooth = True
    print(name, "high faces", len(hi.data.polygons), "low faces", len(lo.data.polygons))
    return hi, lo


def skin_weights(lo, src, arm):
    for g in src.vertex_groups: lo.vertex_groups.new(name=g.name)
    dt = lo.modifiers.new("dt", "DATA_TRANSFER"); dt.object = src
    dt.use_vert_data = True; dt.data_types_verts = {"VGROUP_WEIGHTS"}; dt.vert_mapping = "POLYINTERP_NEAREST"
    dt.layers_vgroup_select_src = "ALL"; dt.layers_vgroup_select_dst = "NAME"
    apply_all(lo)
    # Smooth (3 passes over edge neighbours), keep the 4 strongest influences, normalise. Done in Python:
    # the vertex-group operators refuse to run headless.
    me = lo.data; n = len(me.vertices)
    W = [{g.group: g.weight for g in v.groups if g.weight > 0} for v in me.vertices]
    nb = [[] for _ in range(n)]
    for e in me.edges:
        a, b = e.vertices; nb[a].append(b); nb[b].append(a)
    for _ in range(3):
        NW = []
        for i in range(n):
            acc = {k: v * 0.5 for k, v in W[i].items()}
            if nb[i]:
                f = 0.5 / len(nb[i])
                for j in nb[i]:
                    for k, v in W[j].items(): acc[k] = acc.get(k, 0) + v * f
            NW.append(acc)
        W = NW
    for g in lo.vertex_groups: g.remove(range(n))
    for i, w in enumerate(W):
        top = sorted(w.items(), key=lambda kv: -kv[1])[:4]; s = sum(v for _, v in top) or 1
        for k, v in top: lo.vertex_groups[k].add([i], v / s, "REPLACE")
    lo.parent = arm
    lo.modifiers.new("arm", "ARMATURE").object = arm


def unwrap(lo):
    bpy.context.view_layer.objects.active = lo
    for o in bpy.context.view_layer.objects: o.select_set(o == lo)
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004, area_weight=0.0, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def node(nt, kind, **inputs):
    n = nt.nodes.new(kind)
    for k, v in inputs.items():
        if k.startswith("_"): setattr(n, k[1:], v)
        else: n.inputs[k].default_value = v
    return n


def src_material(name, vein_scale, vein_amt, pore_mask_z=None):
    """Bake-source material on the src parts. Channels (colour, roughness, emission) are routed to the output in turn."""
    m = bpy.data.materials.new(name + "_Src"); nt = m.node_tree; L = nt.links.new
    for n in list(nt.nodes):
        if n.type != "OUTPUT_MATERIAL": nt.nodes.remove(n)
    out = [n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"][0]
    tc = node(nt, "ShaderNodeTexCoord")
    vc = node(nt, "ShaderNodeVertexColor", _layer_name="Col")
    sep = node(nt, "ShaderNodeSeparateColor"); L(vc.outputs["Color"], sep.inputs["Color"])
    mx = node(nt, "ShaderNodeMath", _operation="MAXIMUM"); L(sep.outputs[0], mx.inputs[0]); L(sep.outputs[1], mx.inputs[1])
    mx2 = node(nt, "ShaderNodeMath", _operation="MAXIMUM"); L(mx.outputs[0], mx2.inputs[0]); L(sep.outputs[2], mx2.inputs[1])
    gmask = node(nt, "ShaderNodeMapRange"); gmask.inputs["From Min"].default_value = 0.7; gmask.inputs["From Max"].default_value = 0.95
    L(mx2.outputs[0], gmask.inputs["Value"])
    # grit: mottled two-scale noise, dark cavities from voronoi edges
    n1 = node(nt, "ShaderNodeTexNoise", Scale=38.0, Detail=8.0, Roughness=0.62); L(tc.outputs["Object"], n1.inputs["Vector"])
    n2 = node(nt, "ShaderNodeTexNoise", Scale=6.0, Detail=3.0); L(tc.outputs["Object"], n2.inputs["Vector"])
    vor = node(nt, "ShaderNodeTexVoronoi", Scale=vein_scale, _feature="DISTANCE_TO_EDGE"); L(tc.outputs["Object"], vor.inputs["Vector"])
    edge = node(nt, "ShaderNodeMapRange"); edge.inputs["From Min"].default_value = 0.0; edge.inputs["From Max"].default_value = 0.035
    L(vor.outputs["Distance"], edge.inputs["Value"])          # 0 at a vein, 1 away from it
    mott = node(nt, "ShaderNodeMath", _operation="MULTIPLY_ADD"); L(n1.outputs["Fac"], mott.inputs[0]); mott.inputs[1].default_value = 0.9; mott.inputs[2].default_value = 0.55
    mott2 = node(nt, "ShaderNodeMath", _operation="MULTIPLY_ADD"); L(n2.outputs["Fac"], mott2.inputs[0]); mott2.inputs[1].default_value = 0.8; mott2.inputs[2].default_value = 0.6
    mm = node(nt, "ShaderNodeMath", _operation="MULTIPLY"); L(mott.outputs[0], mm.inputs[0]); L(mott2.outputs[0], mm.inputs[1])
    cav = node(nt, "ShaderNodeMapRange"); L(edge.outputs["Result"], cav.inputs["Value"]); cav.inputs["To Min"].default_value = 0.45; cav.inputs["To Max"].default_value = 1.0
    shade = node(nt, "ShaderNodeMath", _operation="MULTIPLY"); L(mm.outputs[0], shade.inputs[0]); L(cav.outputs["Result"], shade.inputs[1])
    col_dark = node(nt, "ShaderNodeMix", _data_type="RGBA", _blend_type="MULTIPLY"); col_dark.inputs[0].default_value = 1.0
    L(vc.outputs["Color"], col_dark.inputs[6]); L(shade.outputs[0], col_dark.inputs[7])
    base = node(nt, "ShaderNodeMix", _data_type="RGBA"); L(gmask.outputs["Result"], base.inputs[0])
    L(col_dark.outputs[2], base.inputs[6]); L(vc.outputs["Color"], base.inputs[7])   # glow parts keep their clean colour
    # emission: glow parts + faint veins (and pores) on the body
    vein = node(nt, "ShaderNodeMapRange"); L(vor.outputs["Distance"], vein.inputs["Value"])
    vein.inputs["From Min"].default_value = 0.0; vein.inputs["From Max"].default_value = 0.012; vein.inputs["To Min"].default_value = vein_amt; vein.inputs["To Max"].default_value = 0.0
    vn = node(nt, "ShaderNodeTexNoise", Scale=3.0); L(tc.outputs["Object"], vn.inputs["Vector"])
    vbreak = node(nt, "ShaderNodeMapRange"); L(vn.outputs["Fac"], vbreak.inputs["Value"]); vbreak.inputs["From Min"].default_value = 0.48; vbreak.inputs["From Max"].default_value = 0.6
    vv = node(nt, "ShaderNodeMath", _operation="MULTIPLY"); L(vein.outputs["Result"], vv.inputs[0]); L(vbreak.outputs["Result"], vv.inputs[1])
    tot = node(nt, "ShaderNodeMath", _operation="ADD", _use_clamp=True); L(gmask.outputs["Result"], tot.inputs[0]); L(vv.outputs[0], tot.inputs[1])
    ecol = node(nt, "ShaderNodeMix", _data_type="RGBA"); L(gmask.outputs["Result"], ecol.inputs[0])
    ecol.inputs[6].default_value = (0.3, 1.0, 0.85, 1); L(vc.outputs["Color"], ecol.inputs[7])
    emis = node(nt, "ShaderNodeMix", _data_type="RGBA", _blend_type="MULTIPLY"); emis.inputs[0].default_value = 1.0
    L(ecol.outputs[2], emis.inputs[6]); L(tot.outputs[0], emis.inputs[7])
    # roughness: glossy wet chitin in the cavities, drier on top
    rough = node(nt, "ShaderNodeMapRange"); L(n1.outputs["Fac"], rough.inputs["Value"]); rough.inputs["To Min"].default_value = 0.28; rough.inputs["To Max"].default_value = 0.72
    em = node(nt, "ShaderNodeEmission"); L(em.outputs["Emission"], out.inputs["Surface"])
    m["ch"] = 0
    CH = {"color": base.outputs[2], "rough": rough.outputs["Result"], "emit": emis.outputs[2]}
    return m, em, CH


def high_material(name, bump_scale, bump_strength, crackle):
    m = bpy.data.materials.new(name + "_High"); nt = m.node_tree; L = nt.links.new
    b = nt.nodes["Principled BSDF"]
    tc = node(nt, "ShaderNodeTexCoord")
    v = node(nt, "ShaderNodeTexVoronoi", Scale=bump_scale, _feature="DISTANCE_TO_EDGE"); L(tc.outputs["Object"], v.inputs["Vector"])
    n = node(nt, "ShaderNodeTexNoise", Scale=bump_scale * 4, Detail=10.0, Roughness=0.65); L(tc.outputs["Object"], n.inputs["Vector"])
    w = node(nt, "ShaderNodeTexWave", Scale=bump_scale * 0.6, Distortion=6.0, Detail=6.0); L(tc.outputs["Object"], w.inputs["Vector"])
    mix = node(nt, "ShaderNodeMix"); mix.inputs[0].default_value = crackle
    L(w.outputs["Fac"], mix.inputs[2]); L(v.outputs["Distance"], mix.inputs[3])
    add = node(nt, "ShaderNodeMath", _operation="MULTIPLY_ADD"); L(n.outputs["Fac"], add.inputs[0]); add.inputs[1].default_value = 0.35; L(mix.outputs[0], add.inputs[2])
    bp = node(nt, "ShaderNodeBump", Strength=bump_strength, Distance=0.002); L(add.outputs[0], bp.inputs["Height"])
    L(bp.outputs["Normal"], b.inputs["Normal"])
    return m


scene.render.engine = "CYCLES"
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for t in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = t; prefs.get_devices()
            for d in prefs.devices: d.use = True
            scene.cycles.device = "GPU"; print("bake device", t); break
        except Exception: pass
except Exception as ex: print("gpu setup", ex)
scene.cycles.samples = 8
scene.render.bake.margin = 12
scene.render.bake.use_selected_to_active = True


def bake_set(name, lo, hi, src, ext, vein_scale, vein_amt, bump_scale, bump_strength, crackle):
    sm, em, CH = src_material(name, vein_scale, vein_amt)
    src.data.materials.clear(); src.data.materials.append(sm)
    hi.data.materials.clear(); hi.data.materials.append(high_material(name, bump_scale, bump_strength, crackle))
    lm = bpy.data.materials.new(name + "_Bake"); lnt = lm.node_tree
    target = lnt.nodes.new("ShaderNodeTexImage"); lnt.nodes.active = target
    lo.data.materials.clear(); lo.data.materials.append(lm)
    scene.render.bake.cage_extrusion = ext; scene.render.bake.max_ray_distance = ext * 2.5
    imgs = {}
    def run(chan, source, kind, noncolor):
        im = bpy.data.images.new(f"{name}_{chan}", BAKE, BAKE, alpha=False); target.image = im
        if noncolor: im.colorspace_settings.name = "Non-Color"
        for o in bpy.context.view_layer.objects: o.select_set(o in (lo, source))
        bpy.context.view_layer.objects.active = lo
        if kind == "EMIT":
            sm.node_tree.links.new(CH[chan], em.inputs["Color"])
            bpy.ops.object.bake(type="EMIT")
        else:
            bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT")
        im.filepath_raw = os.path.join(OUT, f"{name}_{chan}.png"); im.file_format = "PNG"; im.save()
        imgs[chan] = im; print("baked", name, chan)
    run("color", src, "EMIT", False)
    run("rough", src, "EMIT", True)
    run("emit", src, "EMIT", False)
    run("normal", hi, "NORMAL", True)
    # Final game material: baked PBR.
    fm = bpy.data.materials.new(name); fnt = fm.node_tree; fb = fnt.nodes["Principled BSDF"]; L = fnt.links.new
    def t(chan):
        n = fnt.nodes.new("ShaderNodeTexImage"); n.image = imgs[chan]; return n
    L(t("color").outputs["Color"], fb.inputs["Base Color"])
    L(t("rough").outputs["Color"], fb.inputs["Roughness"])
    nm = fnt.nodes.new("ShaderNodeNormalMap"); L(t("normal").outputs["Color"], nm.inputs["Color"]); L(nm.outputs["Normal"], fb.inputs["Normal"])
    L(t("emit").outputs["Color"], fb.inputs["Emission Color"]); fb.inputs["Emission Strength"].default_value = 1.0
    fb.inputs["Metallic"].default_value = 0.0
    lo.data.materials.clear(); lo.data.materials.append(fm)


SETS = [  # name, src, arm, voxel, smooth iters, displacement [(size, strength)], low faces, cage ext, vein scale, vein amt, bump scale, bump strength, crackle
    ("Tuko_Body", TUKO_SRC, tuko, 0.0035, 4, [(0.03, 0.0025), (0.06, 0.002)], 9000, 0.012, 22.0, 0.35, 60.0, 0.45, 0.85),
    ("Oomi_Body", OOMI_SRC, oomi, 0.008, 4, [(0.12, 0.006), (0.25, 0.008)], 16000, 0.025, 9.0, 0.25, 16.0, 0.35, 0.25),
]
for (name, src, arm, vox, it, disp, lf, ext, vs, va, bs, bst, cr) in SETS:
    hi, lo = make_skin(src, name, vox, it, disp, lf)
    unwrap(lo)
    bake_set(name, lo, hi, src, ext, vs, va, bs, bst, cr)
    skin_weights(lo, src, arm)
    bpy.data.objects.remove(hi)
for src in (TUKO_SRC, OOMI_SRC): bpy.data.objects.remove(src)
for o in list(bpy.data.objects):
    if o.name.endswith(".001"): o.name = o.name[:-4]; o.data.name = o.name
oomi.location.x -= OX  # recentre the rig (its skin is parented and follows)

# Figure: one fused, gnarled skin (geometry only: the game paints it pure black).
fhi, flo = make_skin(fig_src, "Figure", 0.006, 4, [(0.06, 0.004), (0.3, 0.008)], 16000)
bpy.data.objects.remove(fhi); bpy.data.objects.remove(fig_src); flo.name = "Figure"
flo.data.transform(Matrix.Translation(flo.location)); flo.location = (0, 0, 0)  # the game uses the geometry alone
fm = bpy.data.materials.new("Void"); fm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0, 0, 0, 1)
flo.data.materials.clear(); flo.data.materials.append(fm)

# Export.
for o in bpy.context.view_layer.objects: o.select_set(True)
glb = os.path.join(OUT, "creatures.glb")
kw = dict(filepath=glb, export_format="GLB", use_selection=True, export_apply=False, export_yup=True,
          export_animations=True, export_animation_mode="BROADCAST", export_skins=True, export_force_sampling=True)
try:
    bpy.ops.export_scene.gltf(**kw, export_image_format="WEBP", export_image_quality=86)
except TypeError:
    bpy.ops.export_scene.gltf(**kw)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "bc_creatures.blend"))
print("@@DONE@@", glb, os.path.getsize(glb), [o.name for o in bpy.data.objects])
