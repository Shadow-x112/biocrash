# Biocrash props in the dark-alien style, exported as one glTF the game reads meshes from by name.
# Meshes (each one material, sized in metres like the old placeholders):
#   Stone, Stalkwood, Fiber, Sprout, Bulbs, Debris_1..3, Campfire_Stones, Campfire_Scrap, Campfire_Wood, Pack
# Organic glow is carried in the vertex colour's alpha (the game turns it into emission).
# Run: blender -b --factory-startup -P bc_props.py -- <out_dir>
import bpy, bmesh, math, random, os, sys
from mathutils import Vector, noise, Matrix

random.seed(5)
TEX = r"C:\Users\manri\OneDrive\AssetLibrary\Textures\_ThirdParty\PolyHaven"
OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else r"C:\Users\manri\OneDrive\AssetLibrary\3D\Props\bc_props"
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
col = bpy.context.scene.collection


def find(folder, key):
    d = os.path.join(TEX, folder)
    for f in os.listdir(d):
        if key in f.lower(): return os.path.join(d, f)


def tex_mat(name, folder, uv_scale, tint=(1, 1, 1), metal=0.0):
    m = bpy.data.materials.new(name); nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    uv = nt.nodes.new("ShaderNodeTexCoord"); mp = nt.nodes.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (uv_scale, uv_scale, 1)
    nt.links.new(uv.outputs["UV"], mp.inputs["Vector"])
    def img(key, nc):
        p = find(folder, key)
        if not p: return None
        n = nt.nodes.new("ShaderNodeTexImage"); n.image = bpy.data.images.load(p, check_existing=True)
        if nc: n.image.colorspace_settings.name = "Non-Color"
        nt.links.new(mp.outputs["Vector"], n.inputs["Vector"]); return n
    d = img("_diff_", False); nt.links.new(d.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Base Color"].default_value = (*tint, 1)
    r = img("_rough_", True)
    if r: nt.links.new(r.outputs["Color"], b.inputs["Roughness"])
    me = img("_metal_", True)
    if me: nt.links.new(me.outputs["Color"], b.inputs["Metallic"])
    else: b.inputs["Metallic"].default_value = metal
    n = img("_nor_gl_", True)
    if n:
        nm = nt.nodes.new("ShaderNodeNormalMap"); nt.links.new(n.outputs["Color"], nm.inputs["Color"]); nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    return m


def flat_mat(name, rgb, rough, metal=0.0):
    m = bpy.data.materials.new(name); b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    # Vertex colours drive base colour and (alpha) glow in the game.
    a = m.node_tree.nodes.new("ShaderNodeVertexColor"); a.layer_name = "Col"
    m.node_tree.links.new(a.outputs["Color"], b.inputs["Base Color"])
    return m


ROCK = tex_mat("Rock", "dark_rock_02", 1.6, (0.62, 0.62, 0.68))
METAL = tex_mat("ScrapMetal", "rusty_metal_02", 1.0, (0.55, 0.55, 0.58), 0.6)
ORGANIC = flat_mat("Organic", (1, 1, 1), 0.45)


def obj(name, bm, mat, vcol=None):
    if vcol is not None:
        layer = bm.loops.layers.color.new("Col")
        for f in bm.faces:
            for l in f.loops: l[layer] = vcol(l.vert.co)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); col.objects.link(o)
    me.materials.append(mat)
    for p in me.polygons: p.use_smooth = True
    return o


def unwrap(o):
    bpy.ops.object.select_all(action="DESELECT"); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")


def rock_bm(radius, seed, squash=0.7, sub=3):
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=radius)
    for v in bm.verts:
        n = noise.noise(v.co / radius * 1.2 + Vector((seed, 0, 0))) * 0.35 + noise.noise(v.co / radius * 3.5 + Vector((0, seed, 0))) * 0.08
        # flatten one side a little: chipped faces
        v.co *= 1 + n
        v.co.z *= squash
    return bm


# --- Stone (gatherable) ---------------------------------------------------------------------------
st = obj("Stone", rock_bm(0.22, 3.1), ROCK); unwrap(st)

# --- Stalkwood: a broken length of fungal trunk, ridged and twisted, jagged ends --------------------
def trunk_piece(length, r0, r1, seed, rings=14, segs=10):
    bm = bmesh.new(); prev = None; first = None
    for j in range(rings + 1):
        t = j / rings; ring = []
        for i in range(segs):
            a = i / segs * math.tau + t * 1.6
            r = (r0 + (r1 - r0) * t) * (1 + 0.12 * math.sin(a * 5 + t * 7))
            z = t * length - length / 2
            if j in (0, rings): z += (noise.noise(Vector((math.cos(a) * 3, math.sin(a) * 3, seed + j))) * 0.06)  # torn ends
            ring.append(bm.verts.new((math.cos(a) * r, math.sin(a) * r, z)))
        if prev:
            for i in range(segs): bm.faces.new((prev[i], prev[(i + 1) % segs], ring[(i + 1) % segs], ring[i]))
        else: first = ring
        prev = ring
    bm.faces.new(list(reversed(first))); bm.faces.new(prev)
    return bm
TRUNK_C = lambda co: (0.12, 0.1, 0.12, 0.0)
sw = obj("Stalkwood", trunk_piece(1.2, 0.08, 0.06, 1.0), ORGANIC, TRUNK_C)
sw.rotation_euler = (0, math.radians(90), 0)  # lies along X like the old cylinder lay along Y after rotation; game adapts

# --- Fiber: a tuft of thin curved blades, pale glowing tips ----------------------------------------
bm = bmesh.new()
for b in range(11):
    a = b / 11 * math.tau + random.uniform(-0.2, 0.2); h = random.uniform(0.45, 0.8); lean = random.uniform(0.2, 0.55)
    w = 0.018; prevL = prevR = None
    for k in range(7):
        t = k / 6
        c = Vector((math.cos(a) * lean * t * t * h, math.sin(a) * lean * t * t * h, t * h))
        side = Vector((-math.sin(a), math.cos(a), 0)) * w * (1 - t * 0.85)
        L = bm.verts.new(c - side); R = bm.verts.new(c + side)
        if prevL: bm.faces.new((prevL, prevR, R, L))
        prevL, prevR = L, R
def fiber_col(co):
    t = min(1.0, co.z / 0.7)
    return (0.12 + 0.35 * t ** 3, 0.2 + 0.6 * t ** 3, 0.17 + 0.45 * t ** 3, max(0.0, t - 0.75) * 4 * 0.6)
fi = obj("Fiber", bm, ORGANIC, fiber_col)

# --- Sprout: a curled stem with a glowing bulb -----------------------------------------------------
bm = bmesh.new()
stem = trunk_piece(0.32, 0.018, 0.01, 4.0, rings=6, segs=6)
stem.to_mesh(me := bpy.data.meshes.new("tmp")); stem.free(); bm.from_mesh(me); bpy.data.meshes.remove(me)
bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, 0.16))
for v in bm.verts: v.co.x += (v.co.z ** 2) * 0.5
m = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=7, radius=0.045)
bmesh.ops.scale(bm, vec=(1, 1, 1.25), verts=m["verts"]); bmesh.ops.translate(bm, verts=m["verts"], vec=(0.05, 0, 0.34))
sp = obj("Sprout", bm, ORGANIC, lambda co: (0.35, 1.0, 0.85, 1.0) if co.z > 0.3 else (0.08, 0.1, 0.1, 0.0))

# --- Bulbs: a cluster of translucent glowing bulbs on a root knot ---------------------------------
bm = rock_bm(0.12, 9.0, 0.5, 2)
for i in range(8):
    a = random.uniform(0, math.tau); r = random.uniform(0.02, 0.16); s = random.uniform(0.04, 0.11)
    m = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=s)
    bmesh.ops.scale(bm, vec=(1, 1, random.uniform(1.1, 1.9)), verts=m["verts"])
    bmesh.ops.translate(bm, verts=m["verts"], vec=(math.cos(a) * r, math.sin(a) * r, s * 1.3 + 0.03))
bu = obj("Bulbs", bm, ORGANIC, lambda co: (0.45, 0.85, 1.0, 1.0) if co.z > 0.06 else (0.06, 0.06, 0.08, 0.0))

# --- Debris: bent, torn hull plates ---------------------------------------------------------------
def plate(name, sx, sy, bend, seed):
    bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=10, y_segments=6, size=0.5)
    for v in bm.verts:
        v.co.x *= sx; v.co.y *= sy
        v.co.z += math.sin(v.co.x / sx * 2.5) * bend + noise.noise(v.co * 2 + Vector((seed, 0, 0))) * 0.04
    # tear a jagged corner off
    cut = [v for v in bm.verts if v.co.x + v.co.y * 0.8 > (sx + sy) * 0.33 + noise.noise(v.co * 6) * 0.08]
    bmesh.ops.delete(bm, geom=cut, context="VERTS")
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.025)
    o = obj(name, bm, METAL); unwrap(o); return o
plate("Debris_1", 1.6, 0.9, 0.12, 1.0); plate("Debris_2", 1.0, 0.7, 0.2, 2.0); plate("Debris_3", 2.2, 0.6, 0.06, 3.0)

# --- Campfire: a ring of dark stones, a scrap-metal windbreak, broken fungal wood -----------------
bm = bmesh.new()
for i in range(8):
    a = i / 8 * math.tau; s = random.uniform(0.13, 0.19)
    rb = rock_bm(s, i * 1.7, 0.65, 2); tmp = bpy.data.meshes.new("t"); rb.to_mesh(tmp); rb.free()
    tb = bmesh.new(); tb.from_mesh(tmp); bpy.data.meshes.remove(tmp)
    bmesh.ops.translate(tb, verts=tb.verts, vec=(math.cos(a) * 0.48, math.sin(a) * 0.48, s * 0.35))
    tmp = bpy.data.meshes.new("t"); tb.to_mesh(tmp); tb.free(); bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)
cs = obj("Campfire_Stones", bm, ROCK); unwrap(cs)
bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=8, y_segments=4, size=0.5)
for v in bm.verts:
    a = v.co.x * 1.6  # curve it around the back of the ring
    r = 0.72; x, y = math.sin(a) * r, -math.cos(a) * r
    v.co = Vector((x, y, (v.co.y + 0.5) * 0.55 + noise.noise(Vector((x * 4, y * 4, 1))) * 0.04))
cut = [v for v in bm.verts if v.co.z > 0.42 + noise.noise(v.co * 7) * 0.12]
bmesh.ops.delete(bm, geom=cut, context="VERTS")
bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.02)
csc = obj("Campfire_Scrap", bm, METAL); unwrap(csc)
bm = bmesh.new()
for i in range(4):
    p = trunk_piece(0.8, 0.065, 0.045, 10 + i, rings=8, segs=8)
    tmp = bpy.data.meshes.new("t"); p.to_mesh(tmp); p.free()
    tb = bmesh.new(); tb.from_mesh(tmp); bpy.data.meshes.remove(tmp)
    a = i / 4 * math.tau + 0.4
    rot = Matrix.Rotation(a, 4, "Z") @ Matrix.Rotation(math.radians(58), 4, "Y")
    bmesh.ops.transform(tb, matrix=rot, verts=tb.verts)
    bmesh.ops.translate(tb, verts=tb.verts, vec=(math.cos(a) * 0.14, math.sin(a) * 0.14, 0.24))
    tmp = bpy.data.meshes.new("t"); tb.to_mesh(tmp); tb.free(); bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)
cw = obj("Campfire_Wood", bm, ORGANIC, lambda co: (0.1, 0.08, 0.09, 0.0) if co.z > 0.12 else (0.5, 0.18, 0.05, 0.6))  # embers at the foot

# --- Pack: a soft suit-fabric bag with a strap and a hazard stripe --------------------------------
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=4, use_grid_fill=True)
for v in bm.verts:
    v.co = v.co.normalized() * 0.5 * 0.6 + v.co * 0.4
    v.co.x *= 0.56; v.co.y *= 0.42; v.co.z *= 0.36
    v.co += Vector((0, 0, 0.18)) + Vector((noise.noise(v.co * 6), noise.noise(v.co * 6 + Vector((3, 0, 0))), 0)) * 0.015
m = bmesh.ops.create_cone(bm, cap_ends=False, segments=16, radius1=0.2, radius2=0.2, depth=0.04)
for v in m["verts"]:
    v.co = Matrix.Rotation(math.radians(90), 4, "Y") @ v.co
bmesh.ops.translate(bm, verts=m["verts"], vec=(0, 0, 0.28))
pk = obj("Pack", bm, ORGANIC, lambda co: (0.85, 0.36, 0.1, 0.35) if abs(co.x) < 0.04 else (0.62, 0.64, 0.66, 0.0))

# Export (Y up), textures as WebP.
for o in col.objects: o.select_set(True)
glb = os.path.join(OUT, "props.glb")
kw = dict(filepath=glb, export_format="GLB", use_selection=True, export_apply=True, export_yup=True)
try: bpy.ops.export_scene.gltf(**kw, export_image_format="WEBP", export_image_quality=88)
except TypeError: bpy.ops.export_scene.gltf(**kw)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "bc_props.blend"))
print("@@DONE@@", glb, os.path.getsize(glb), [(o.name, len(o.data.polygons)) for o in col.objects])
