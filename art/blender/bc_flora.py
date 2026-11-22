# Biocrash giant bell fungus (the forest's main tree) + a tiling detail texture for its shader.
# The game stretches the trunk per fungus and scales the crown by the cap radius, so the mesh is authored in "unit"
# space with a per-vertex part tag, exactly like the old code-built mesh:
#   trunk (_apart 0): 1 tall, ~0.75 radius, root buttresses at the foot; stretched by the shader
#   crown (_apart 1): cap radius 1; trunk top sits at crown y = 0
# Per-vertex attributes (exported as glTF custom attributes): _apart, _atint (1 cap skin with veins, 2 tendril),
# _aglow (<0: dim self-light: lining, gills, skirt), _atend (0..1 along a tendril).
# The outer cap keeps the old bell profile (the game builds the physics hull from the same formula).
# Detail texture (RGB, tiles seamlessly, made with 4-D noise on a torus): R skin warts/pores, G trunk fibres
# (streaks along v), B blotches (colour and roughness variation). The game samples it triplanar in metres.
# Run: blender -b --factory-startup -P bc_flora.py -- <repo_root>
import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Vector, noise

ROOT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else r"C:\Users\manri\Documents\biocrash"
OUT = os.path.join(ROOT, "art", "out", "flora"); os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection
TAU = math.tau
PHI_END = math.pi * 0.62


def V(x, y, z):  # author in three.js axes (y up), store in Blender axes (z up); the exporter's +Y up undoes this
    return Vector((x, -z, y))


# ------------------------------------------------------------------------------------------------ mesh
bm = bmesh.new()
L = {k: bm.verts.layers.float.new(k) for k in ("_apart", "_atint", "_aglow", "_atend")}


def vert(p, part, tint=0.0, glow=0.0, tend=0.0):
    v = bm.verts.new(V(*p))
    v[L["_apart"]] = part; v[L["_atint"]] = tint; v[L["_aglow"]] = glow; v[L["_atend"]] = tend
    return v


def grid(rows, flip=False, closed=True):
    """Faces between consecutive rings of verts (each ring a list); closed rings wrap around."""
    for j in range(len(rows) - 1):
        a, b = rows[j], rows[j + 1]
        n = len(a) if closed else len(a) - 1
        for i in range(n):
            q = (a[i], a[(i + 1) % len(a)], b[(i + 1) % len(b)], b[i])
            bm.faces.new(tuple(reversed(q)) if flip else q)


def nz(x, y, z, s=1.0):
    return noise.noise(Vector((x * s, y * s, z * s)))


# Trunk: twisted fibrous ridges, a flared foot with root buttresses that dig into the ground.
TR, TS = 32, 24
rows = []
for j in range(TS + 1):
    t = j / TS
    tt = t ** 1.15  # more rings near the foot, where the shape changes fastest
    ring = []
    for i in range(TR):
        a = i / TR * TAU + tt * 2.2
        r = (1 + 0.95 * math.exp(-((tt / 0.09) ** 2)) - 0.3 * tt + 0.06 * math.sin(tt * 17)) * (1 + 0.1 * math.sin(a * 5 + tt * 6))
        r *= 1 + 0.035 * math.sin(a * 23 + tt * 40) + 0.03 * nz(math.cos(a) * 2, tt * 9, math.sin(a) * 2)  # fibres and knots
        r *= 1 + 0.9 * math.exp(-((tt / 0.07) ** 2)) * max(0.0, math.cos(a * 5 + 0.7)) ** 4  # five buttresses
        ring.append(vert((math.cos(a) * r * 0.75, tt, math.sin(a) * r * 0.75), 0))
    rows.append(ring)
grid(rows, flip=True)


def bell(s, a, inner):
    phi = s * PHI_END
    lobe = 1 + 0.08 * math.sin(a * 7) * s * s
    k = 0.95 if inner else 1.0
    y = (math.cos(phi) * 0.75 - 0.12) * (0.97 if inner else 1.0) - (0.03 if inner else 0.0)
    return Vector((math.cos(a) * math.sin(phi) * lobe * k, y, math.sin(a) * math.sin(phi) * lobe * k))


def bell_n(s, a):  # outward normal of the outer bell (finite differences)
    e = 1e-3
    p = bell(s, a, False)
    ds = bell(min(1, s + e), a, False) - bell(max(0, s - e), a, False)
    da = bell(s, a + e, False) - bell(s, a - e, False)
    n = ds.cross(da).normalized()
    return n if n.dot(p - Vector((0, -0.2, 0))) > 0 else -n


# Outer cap skin: the old bell with warts and a ragged, slightly upturned rim. Veins glow in the shader (_atint 1).
CS, CA = 18, 56
rows = []
for j in range(CS + 1):
    s = j / CS
    ring = []
    for i in range(CA):
        a = i / CA * TAU
        p = bell(s, a, False)
        n = bell_n(max(s, 0.02), a)
        wart = max(0.0, nz(p.x, p.y, p.z, 9.0) - 0.15) * 0.06 * (0.3 + s)  # blistered skin, worst toward the rim
        rag = (max(0.0, nz(p.x, 0, p.z, 6.0)) * 0.05 + 0.02 * math.sin(a * 19)) * max(0.0, s - 0.85) / 0.15
        p = p + n * wart + Vector((p.x, 0.25, p.z)).normalized() * rag
        ring.append(vert(tuple(p), 1, tint=1.0))
    rows.append(ring)
grid(rows)
outer_rim = rows[-1]

# Inner lining (faces down, dim self-light), joined to the outer rim by a thin band.
rows = []
for j in range(CS + 1):
    s = j / CS
    rows.append([vert(tuple(bell(s, i / CA * TAU, True)), 1, glow=-0.35) for i in range(CA)])
grid(rows, flip=True)
grid([outer_rim, rows[-1]])

# Gills: thin radial plates under the cap, deepest mid-way, their free edges glowing faintly.
NG, GS = 64, 9
for g in range(NG):
    a = g / NG * TAU + 0.013 * math.sin(g * 7.3)
    s0 = 0.2 if g % 2 == 0 else 0.42  # short gills between the long ones
    top, bot = [], []
    for k in range(GS + 1):
        s = s0 + (0.965 - s0) * k / GS
        p = bell(s, a, True) * 0.985
        depth = 0.12 * max(0.0, math.sin(math.pi * (s - s0) / (0.965 - s0))) ** 0.8 * (1 + 0.25 * nz(g, s * 5, 0))
        wav = 0.012 * math.sin(s * 30 + g)
        side = Vector((-math.sin(a), 0, math.cos(a))) * wav
        top.append(vert(tuple(p + side), 1, glow=-0.25))
        bot.append(vert(tuple(p + side + Vector((-math.cos(a) * depth * 0.25, -depth, -math.sin(a) * depth * 0.25))), 1, glow=-0.75))
    grid([top, bot], closed=False)

# Neck: the stem carries on up into the cap (no gap between trunk top and cap roof).
NR, NS = 20, 8
rows = []
for j in range(NS + 1):
    t = j / NS
    y = -0.06 + t * 0.66
    r = 0.1 + 0.11 * t ** 3
    rows.append([vert((math.cos(i / NR * TAU) * r * (1 + 0.06 * math.sin(i / NR * TAU * 5 + t * 4)), y, math.sin(i / NR * TAU) * r), 1, glow=-0.1) for i in range(NR)])
grid(rows, flip=True)

# Skirt (annulus): a torn membrane hanging from the neck, frilled at its edge.
SR, SS = 56, 6
rows = []
for j in range(SS + 1):
    t = j / SS
    ring = []
    for i in range(SR):
        a = i / SR * TAU
        frill = 0.04 * math.sin(a * 11) * t + 0.05 * max(0.0, nz(math.cos(a) * 3, 0, math.sin(a) * 3)) * t
        r = 0.115 + t * (0.17 + frill)
        y = 0.36 - t * (0.16 + 0.05 * math.sin(a * 6)) - t * t * 0.05
        ring.append(vert((math.cos(a) * r, y, math.sin(a) * r), 1, glow=-0.3 - 0.3 * t))
    rows.append(ring)
grid(rows)

# Tendrils: luminous threads hanging from just inside the rim, some ending in a small bead.
NT, TSG, TSD = 22, 9, 5
for n in range(NT):
    a = n / NT * TAU + math.sin(n * 12.9) * 0.12
    root = bell(0.93 + 0.05 * ((n * 37) % 7) / 7, a, True)
    ln = 0.6 + ((math.sin(n * 78.2) * 43758.5) % 1 + 1) % 1 * 1.1
    thick = 0.009 + 0.008 * (((n * 53) % 5) / 5)
    pts = [root + Vector((math.sin(t * 3 + n) * 0.06 * t, -ln * t, math.cos(t * 2.5 + n) * 0.06 * t)) for t in (k / TSG for k in range(TSG + 1))]
    rings = []
    for k, p in enumerate(pts):
        t = k / TSG
        r = thick * (1 - t * 0.7)
        if n % 3 == 0 and k == TSG: r = thick * 1.6  # a bead at the tip
        rings.append([vert(tuple(p + Vector((math.cos(b / TSD * TAU) * r, 0, math.sin(b / TSD * TAU) * r))), 1, tint=2.0, tend=t) for b in range(TSD)])
    grid(rings, flip=True)

bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces])  # not trusted for open sheets; the material is double-sided
me = bpy.data.meshes.new("Fungus"); bm.to_mesh(me); bm.free()
for p in me.polygons: p.use_smooth = True
fungus = bpy.data.objects.new("Fungus", me); col.objects.link(fungus)
print("fungus tris", sum(len(p.vertices) - 2 for p in me.polygons))

bpy.ops.object.select_all(action="DESELECT"); fungus.select_set(True); bpy.context.view_layer.objects.active = fungus
glb = os.path.join(OUT, "flora.glb")
bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_yup=True, export_attributes=True,
                          export_normals=True, export_texcoords=False, export_materials="NONE")
print("exported", glb, os.path.getsize(glb))

# ------------------------------------------------------------------------------------------------ detail texture
SIZE = 1024
bpy.ops.mesh.primitive_plane_add(size=2); plane = bpy.context.active_object
scene.render.engine = "CYCLES"; scene.cycles.samples = 1; scene.cycles.device = "CPU"
mat = bpy.data.materials.new("Bake"); plane.data.materials.append(mat)
nt = mat.node_tree; nodes, links = nt.nodes, nt.links
for nd in list(nodes): nodes.remove(nd)
out = nodes.new("ShaderNodeOutputMaterial"); em = nodes.new("ShaderNodeEmission"); links.new(em.outputs[0], out.inputs[0])
uv = nodes.new("ShaderNodeTexCoord"); sep = nodes.new("ShaderNodeSeparateXYZ"); links.new(uv.outputs["UV"], sep.inputs[0])


def m(op, a, b=None):
    n = nodes.new("ShaderNodeMath"); n.operation = op
    for i, x in enumerate((a, b)):
        if x is None: continue
        if isinstance(x, (int, float)): n.inputs[i].default_value = x
        else: links.new(x, n.inputs[i])
    return n.outputs[0]


def torus(ru, rv):
    """Seamless 4-D coordinates for the UV square: (cos u, sin u, cos v, sin v) scaled per axis."""
    u = m("MULTIPLY", sep.outputs[0], TAU); v = m("MULTIPLY", sep.outputs[1], TAU)
    comb = nodes.new("ShaderNodeCombineXYZ")
    links.new(m("MULTIPLY", m("COSINE", u), ru), comb.inputs[0]); links.new(m("MULTIPLY", m("SINE", u), ru), comb.inputs[1])
    links.new(m("MULTIPLY", m("COSINE", v), rv), comb.inputs[2])
    return comb.outputs[0], m("MULTIPLY", m("SINE", v), rv)


def tex(kind, ru, rv, **kw):
    vec, w = torus(ru, rv)
    t = nodes.new(kind)
    if kind == "ShaderNodeTexNoise": t.noise_dimensions = "4D"
    else: t.voronoi_dimensions = "4D"
    links.new(vec, t.inputs["Vector"]); links.new(w, t.inputs["W"])
    for k, v in kw.items():
        if k.startswith("_"): setattr(t, k[1:], v)
        else: t.inputs[k].default_value = v
    return t


def bake_channel(sock):
    links.new(sock, em.inputs["Color"])
    img = bpy.data.images.new("ch", SIZE, SIZE, float_buffer=True)
    tn = nodes.new("ShaderNodeTexImage"); tn.image = img; nodes.active = tn
    bpy.ops.object.bake(type="EMIT", margin=0)
    a = np.array(img.pixels[:], dtype=np.float32).reshape(SIZE, SIZE, 4)[:, :, 0]
    nodes.remove(tn)
    lo, hi = np.percentile(a, 1), np.percentile(a, 99)
    return np.clip((a - lo) / max(1e-6, hi - lo), 0, 1)


# R: blistered skin: soft voronoi cells (raised), fine pores, a little wrinkle noise.
cells = tex("ShaderNodeTexVoronoi", 5.0, 5.0, _feature="SMOOTH_F1", Smoothness=0.6)
pores = tex("ShaderNodeTexVoronoi", 22.0, 22.0)
wr = tex("ShaderNodeTexNoise", 3.0, 3.0, Scale=4.0, Detail=8.0, Roughness=0.6)
skin = m("ADD", m("MULTIPLY", m("SUBTRACT", 1.0, cells.outputs["Distance"]), 0.7), m("MULTIPLY", wr.outputs["Fac"], 0.35))
skin = m("SUBTRACT", skin, m("MULTIPLY", m("LESS_THAN", pores.outputs["Distance"], 0.12), 0.25))
R = bake_channel(skin)
# G: fibres: high frequency across (u), low along (v): streaks that run with the trunk.
fib = tex("ShaderNodeTexNoise", 26.0, 1.2, Scale=1.0, Detail=6.0, Roughness=0.7)
fib2 = tex("ShaderNodeTexNoise", 60.0, 2.5, Scale=1.0, Detail=3.0)
G = bake_channel(m("ADD", fib.outputs["Fac"], m("MULTIPLY", fib2.outputs["Fac"], 0.4)))
# B: large blotches (colour, roughness, wet patches).
bl = tex("ShaderNodeTexNoise", 1.6, 1.6, Scale=1.5, Detail=4.0, Roughness=0.55)
B = bake_channel(bl.outputs["Fac"])

rgb = np.stack([R, G, B, np.ones_like(R)], axis=-1)
img = bpy.data.images.new("fungus_detail", SIZE, SIZE, alpha=False)
img.pixels[:] = rgb.astype(np.float32).ravel()
path = os.path.join(ROOT, "public", "textures", "fungus_detail.webp")
scene.render.image_settings.file_format = "WEBP"; scene.render.image_settings.quality = 92
img.save_render(path)
print("texture", path, os.path.getsize(path))
print("@@DONE@@")
