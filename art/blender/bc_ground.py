# Biocrash alien ground layer: one tiling RGBA texture the terrain shader lays over the photographed soil/ash/rock.
#   R  moss clumps (height of the dark alien moss tufts on flat soil)
#   G  wet patches (low frequency: where the ground holds water and turns slick)
#   B  spore specks (tiny dots that glow in the moss at night)
#   A  mycelium (a thin thread network under the soil that glows faintly, the forest's roots)
# Seamless: every channel is 4-D noise on a torus (cos u, sin u, cos v, sin v).
# Run: blender -b --factory-startup -P bc_ground.py -- <repo_root>
import bpy, math, os, sys
import numpy as np

ROOT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else r"C:\Users\manri\Documents\biocrash"
SIZE = 1024
TAU = math.tau
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"; scene.cycles.samples = 1; scene.cycles.device = "CPU"
bpy.ops.mesh.primitive_plane_add(size=2); plane = bpy.context.active_object
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


def torus(ru, rv, warp=None, amt=0.0):
    u = m("MULTIPLY", sep.outputs[0], TAU); v = m("MULTIPLY", sep.outputs[1], TAU)
    if warp is not None:  # domain warp, kept seamless because the warp itself is periodic
        u = m("ADD", u, m("MULTIPLY", warp, amt)); v = m("ADD", v, m("MULTIPLY", warp, amt * 0.8))
    comb = nodes.new("ShaderNodeCombineXYZ")
    links.new(m("MULTIPLY", m("COSINE", u), ru), comb.inputs[0]); links.new(m("MULTIPLY", m("SINE", u), ru), comb.inputs[1])
    links.new(m("MULTIPLY", m("COSINE", v), rv), comb.inputs[2])
    return comb.outputs[0], m("MULTIPLY", m("SINE", v), rv)


def tex(kind, ru, rv, warp=None, amt=0.0, **kw):
    vec, w = torus(ru, rv, warp, amt)
    t = nodes.new(kind)
    if kind == "ShaderNodeTexNoise": t.noise_dimensions = "4D"
    else: t.voronoi_dimensions = "4D"
    links.new(vec, t.inputs["Vector"]); links.new(w, t.inputs["W"])
    for k, v in kw.items():
        if k.startswith("_"): setattr(t, k[1:], v)
        else: t.inputs[k].default_value = v
    return t


def bake(sock, norm=True):
    links.new(sock, em.inputs["Color"])
    img = bpy.data.images.new("ch", SIZE, SIZE, float_buffer=True)
    tn = nodes.new("ShaderNodeTexImage"); tn.image = img; nodes.active = tn
    bpy.ops.object.bake(type="EMIT", margin=0)
    a = np.array(img.pixels[:], dtype=np.float32).reshape(SIZE, SIZE, 4)[:, :, 0]
    nodes.remove(tn)
    if not norm: return np.clip(a, 0, 1)
    lo, hi = np.percentile(a, 1), np.percentile(a, 99)
    return np.clip((a - lo) / max(1e-6, hi - lo), 0, 1)


warp = tex("ShaderNodeTexNoise", 1.5, 1.5, Scale=1.2, Detail=3.0).outputs["Fac"]
warp = m("SUBTRACT", warp, 0.5)

# R: moss clumps: soft cells, fuzzed by fine noise so edges read as tufts, not blobs.
cl = tex("ShaderNodeTexVoronoi", 4.5, 4.5, warp, 0.25, _feature="SMOOTH_F1", Smoothness=0.8)
fz = tex("ShaderNodeTexNoise", 12.0, 12.0, Scale=2.0, Detail=10.0, Roughness=0.7)
R = bake(m("ADD", m("MULTIPLY", m("SUBTRACT", 1.0, cl.outputs["Distance"]), 0.8), m("MULTIPLY", fz.outputs["Fac"], 0.3)))
# G: wet patches.
wt = tex("ShaderNodeTexNoise", 1.3, 1.3, warp, 0.6, Scale=1.4, Detail=5.0, Roughness=0.6)
G = bake(wt.outputs["Fac"])
# B: spore specks: small dots (dark = speck), only some cells.
sp = tex("ShaderNodeTexVoronoi", 30.0, 30.0)
spm = tex("ShaderNodeTexNoise", 6.0, 6.0, Scale=2.0, Detail=2.0)
speck = m("MULTIPLY", m("LESS_THAN", sp.outputs["Distance"], 0.2), m("GREATER_THAN", spm.outputs["Fac"], 0.45))
B = bake(m("SUBTRACT", 1.0, speck), norm=False)
# A: mycelium: thin cell edges, warped hard so they wander like roots, broken up so the net isn't closed.
my = tex("ShaderNodeTexVoronoi", 3.0, 3.0, warp, 0.45, _feature="DISTANCE_TO_EDGE")
br = tex("ShaderNodeTexNoise", 5.0, 5.0, Scale=2.0, Detail=4.0)
line = m("MULTIPLY", m("SUBTRACT", 1.0, m("MINIMUM", m("MULTIPLY", my.outputs["Distance"], 9.0), 1.0)), m("GREATER_THAN", br.outputs["Fac"], 0.5))
fine = tex("ShaderNodeTexVoronoi", 8.0, 8.0, warp, 0.5, _feature="DISTANCE_TO_EDGE")
line = m("MAXIMUM", line, m("MULTIPLY", m("SUBTRACT", 1.0, m("MINIMUM", m("MULTIPLY", fine.outputs["Distance"], 20.0), 1.0)), m("MULTIPLY", m("GREATER_THAN", br.outputs["Fac"], 0.55), 0.35)))
A = bake(line, norm=False)

rgba = np.stack([R, G, B, A], axis=-1).astype(np.float32)
img = bpy.data.images.new("ground_alien", SIZE, SIZE, alpha=True, float_buffer=False)
img.alpha_mode = "STRAIGHT"
img.pixels[:] = rgba.ravel()
path = os.path.join(ROOT, "art", "out", "ground_alien.png")
os.makedirs(os.path.dirname(path), exist_ok=True)
img.filepath_raw = path; img.file_format = "PNG"; img.save()
print("texture", path, os.path.getsize(path))
print("@@DONE@@")
