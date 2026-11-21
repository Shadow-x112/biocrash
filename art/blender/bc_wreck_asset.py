# Biocrash: the crashed station module as a game asset (.glb).
# Builds the wreck, gives it UVs, bakes its layered hull material (plates + rust + scorch) into 4K PBR maps,
# and exports a glTF with: Wreck_Hull (baked PBR), Wreck_Interior (dark), Wreck_Lights (emissive),
# Wreck_Solar (panel), COL_Wreck (simple collision mesh, no material).
# Run: blender -b --factory-startup -P bc_wreck_asset.py -- <out_dir> [bake_size]
import bpy, bmesh, math, random, os, sys
from mathutils import Vector, noise

random.seed(11)
TEX = r"C:\Users\manri\OneDrive\AssetLibrary\Textures\_ThirdParty\PolyHaven"
args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = args[0] if args else r"C:\Users\manri\OneDrive\AssetLibrary\3D\Environment\bc_crash_site"
BAKE = int(args[1]) if len(args) > 1 else 4096
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection


def link(o):
    col.objects.link(o); return o


def find(folder, key):
    d = os.path.join(TEX, folder)
    for f in os.listdir(d):
        if key in f.lower():
            return os.path.join(d, f)


def img_node(nt, path, noncolor, vec):
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = bpy.data.images.load(path, check_existing=True)
    if noncolor: n.image.colorspace_settings.name = "Non-Color"
    n.projection = "BOX"; n.projection_blend = 0.25
    nt.links.new(vec, n.inputs["Vector"])
    return n


def active(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True); bpy.context.view_layer.objects.active = o


def apply_all(o):
    active(o)
    for m in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


# ---------------------------------------------------------------------------------------------
# The layered hull material (box-projected in object space; it gets baked to UV maps below).
def hull_material():
    m = bpy.data.materials.new("HullSource"); nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord"); mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (0.45, 0.45, 0.45)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"]); v = mp.outputs["Vector"]
    plate = img_node(nt, find("metal_plate_02", "_diff_"), False, v)
    rust = img_node(nt, find("rusty_metal_02", "_diff_"), False, v)
    tint = nt.nodes.new("ShaderNodeMix"); tint.data_type = "RGBA"; tint.blend_type = "MULTIPLY"; tint.inputs["Factor"].default_value = 1
    nt.links.new(plate.outputs["Color"], tint.inputs["A"]); tint.inputs["B"].default_value = (0.45, 0.47, 0.5, 1)
    nz = nt.nodes.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 1.6; nz.inputs["Detail"].default_value = 8
    nt.links.new(v, nz.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB"); ramp.color_ramp.elements[0].position = 0.58; ramp.color_ramp.elements[1].position = 0.72
    nt.links.new(nz.outputs["Fac"], ramp.inputs["Fac"])
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"
    nt.links.new(ramp.outputs["Color"], mix.inputs["Factor"]); nt.links.new(tint.outputs["Result"], mix.inputs["A"]); nt.links.new(rust.outputs["Color"], mix.inputs["B"])
    # Scorch: darker toward the torn (+X) end and underneath.
    sep = nt.nodes.new("ShaderNodeSeparateXYZ"); nt.links.new(tc.outputs["Object"], sep.inputs["Vector"])
    sx = nt.nodes.new("ShaderNodeMapRange"); sx.inputs["From Min"].default_value = 1; sx.inputs["From Max"].default_value = 7.5
    nt.links.new(sep.outputs["X"], sx.inputs["Value"])
    nz2 = nt.nodes.new("ShaderNodeTexNoise"); nz2.inputs["Scale"].default_value = 3; nz2.inputs["Detail"].default_value = 10
    nt.links.new(v, nz2.inputs["Vector"])
    sc = nt.nodes.new("ShaderNodeMath"); sc.operation = "MULTIPLY"
    nt.links.new(sx.outputs["Result"], sc.inputs[0]); nt.links.new(nz2.outputs["Fac"], sc.inputs[1])
    sc2 = nt.nodes.new("ShaderNodeMath"); sc2.operation = "MULTIPLY"; sc2.inputs[1].default_value = 1.6; sc2.use_clamp = True
    nt.links.new(sc.outputs[0], sc2.inputs[0])
    burn = nt.nodes.new("ShaderNodeMix"); burn.data_type = "RGBA"
    nt.links.new(sc2.outputs[0], burn.inputs["Factor"]); nt.links.new(mix.outputs["Result"], burn.inputs["A"]); burn.inputs["B"].default_value = (0.02, 0.018, 0.016, 1)
    color = burn.outputs["Result"]
    nt.links.new(color, b.inputs["Base Color"])
    ro = img_node(nt, find("metal_plate_02", "_rough_"), True, v)
    rr = img_node(nt, find("rusty_metal_02", "_rough_"), True, v)
    rmix = nt.nodes.new("ShaderNodeMix"); rmix.data_type = "FLOAT"
    nt.links.new(ramp.outputs["Color"], rmix.inputs["Factor"]); nt.links.new(ro.outputs["Color"], rmix.inputs["A"]); nt.links.new(rr.outputs["Color"], rmix.inputs["B"])
    rough = nt.nodes.new("ShaderNodeMath"); rough.operation = "MAXIMUM"
    nt.links.new(rmix.outputs["Result"], rough.inputs[0]); nt.links.new(sc2.outputs[0], rough.inputs[1])
    nt.links.new(rough.outputs[0], b.inputs["Roughness"])
    me = img_node(nt, find("metal_plate_02", "_metal_"), True, v)
    metal = nt.nodes.new("ShaderNodeMath"); metal.operation = "MULTIPLY"
    inv = nt.nodes.new("ShaderNodeMath"); inv.operation = "SUBTRACT"; inv.inputs[0].default_value = 1
    nt.links.new(ramp.outputs["Color"], inv.inputs[1])
    nt.links.new(me.outputs["Color"], metal.inputs[0]); nt.links.new(inv.outputs[0], metal.inputs[1])
    nt.links.new(metal.outputs[0], b.inputs["Metallic"])
    nm = nt.nodes.new("ShaderNodeNormalMap"); nm.inputs["Strength"].default_value = 1.3
    nn = img_node(nt, find("metal_plate_02", "_nor_gl_"), True, v); nt.links.new(nn.outputs["Color"], nm.inputs["Color"])
    dn = img_node(nt, find("rusty_metal_02", "_disp_"), True, v)
    bp = nt.nodes.new("ShaderNodeBump"); bp.inputs["Strength"].default_value = 0.4; bp.inputs["Distance"].default_value = 0.02
    nt.links.new(dn.outputs["Color"], bp.inputs["Height"]); nt.links.new(nm.outputs["Normal"], bp.inputs["Normal"])
    nt.links.new(bp.outputs["Normal"], b.inputs["Normal"])
    return m, {"color": color, "rough": rough.outputs[0], "metal": metal.outputs[0]}


hull_src, chans = hull_material()

# ---------------------------------------------------------------------------------------------
# Geometry (local: X along the module, Z up; origin at the module's centre line).
parts = []
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=3.0, depth=15, rotation=(0, math.radians(90), 0))
hull = bpy.context.active_object; hull.name = "Hull"
hull.modifiers.new("shell", "SOLIDIFY").thickness = 0.18
bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=5, radius=3.6)
for v in bm.verts:
    d = noise.noise(v.co * 0.7 + Vector((3, 1, 2))) * 1.2 + noise.noise(v.co * 2.2) * 0.3 + noise.noise(v.co * 7) * 0.06
    v.co *= 1 + d * 0.35
me = bpy.data.meshes.new("cut"); bm.to_mesh(me); bm.free()
cut = link(bpy.data.objects.new("TearCutter", me)); cut.location = (7.4, 0.2, 1.0)
bo = hull.modifiers.new("tear", "BOOLEAN"); bo.object = cut; bo.operation = "DIFFERENCE"; bo.solver = "EXACT"
bv = hull.modifiers.new("bevel", "BEVEL"); bv.width = 0.03; bv.segments = 2; bv.limit_method = "ANGLE"
apply_all(hull); parts.append(hull)
# Rear dome cap with a docking ring.
bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=24, radius=3.0, location=(-7.5, 0, 0))
capo = bpy.context.active_object
for v in capo.data.vertices:
    if v.co.x > 0: v.co.x = 0
    else: v.co.x *= 0.45
parts.append(capo)
bpy.ops.mesh.primitive_torus_add(major_radius=1.1, minor_radius=0.18, major_segments=32, minor_segments=8, location=(-8.85, 0, 0), rotation=(0, math.radians(90), 0))
parts.append(bpy.context.active_object)
# Ribs.
for x in [-6.8, -4.2, -1.4, 1.4, 4.0]:
    bpy.ops.mesh.primitive_torus_add(major_radius=3.12, minor_radius=0.16, major_segments=64, minor_segments=8, location=(x, 0, 0), rotation=(0, math.radians(90), 0))
    r = bpy.context.active_object
    r.modifiers.new("tear", "BOOLEAN").object = cut
    r.modifiers["tear"].solver = "EXACT"
    apply_all(r); parts.append(r)
# Greebles along the top: equipment boxes, conduit, an antenna dish.
for i in range(9):
    x = random.uniform(-6.5, 3.0); a = random.uniform(-0.6, 0.6)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, math.sin(a) * 3.05, math.cos(a) * 3.05))
    g = bpy.context.active_object; g.scale = (random.uniform(0.4, 1.4), random.uniform(0.3, 0.8), random.uniform(0.15, 0.4)); g.rotation_euler = (a * -1, 0, 0)
    bev = g.modifiers.new("b", "BEVEL"); bev.width = 0.04; bev.segments = 2
    apply_all(g); parts.append(g)
bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.09, depth=11, location=(-1.5, 2.35, 1.95), rotation=(0, math.radians(90), 0))
parts.append(bpy.context.active_object)
bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.12, depth=5, location=(-3.5, 0, 4.8))
parts.append(bpy.context.active_object)
bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=0.9, radius2=0.1, depth=0.4, location=(-6.0, -1.2, 3.3), rotation=(math.radians(30), math.radians(-20), 0))
dish = bpy.context.active_object; dish.modifiers.new("s", "SOLIDIFY").thickness = 0.03; apply_all(dish); parts.append(dish)
cut.hide_render = True

for p in parts:
    p.data.materials.clear(); p.data.materials.append(hull_src)
active(parts[0])
for p in parts: p.select_set(True)
bpy.ops.object.join()
hullj = bpy.context.active_object; hullj.name = "Wreck_Hull"
bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))

# Interior (dark, seen through the tear).
bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=2.78, depth=14.6, rotation=(0, math.radians(90), 0))
inner = bpy.context.active_object; inner.name = "Wreck_Interior"
ib = inner.modifiers.new("tear", "BOOLEAN"); ib.object = cut; ib.solver = "EXACT"; apply_all(inner)
active(inner); bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT"); bpy.ops.mesh.flip_normals(); bpy.ops.object.mode_set(mode="OBJECT")
im = bpy.data.materials.new("WreckInterior"); ib_ = im.node_tree.nodes["Principled BSDF"]
ib_.inputs["Base Color"].default_value = (0.012, 0.012, 0.014, 1); ib_.inputs["Roughness"].default_value = 0.85; ib_.inputs["Metallic"].default_value = 0.6
inner.data.materials.append(im)

# Lights: the window strip (teal, still powered inside) and three red warning beacons.
def emat(name, c, s):
    m = bpy.data.materials.new(name); b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*c, 1); b.inputs["Emission Color"].default_value = (*c, 1); b.inputs["Emission Strength"].default_value = s
    return m
lights = []
bpy.ops.mesh.primitive_cube_add(size=1, location=(-2.8, -3.0, 0.9)); w = bpy.context.active_object; w.scale = (4.5, 0.1, 0.35); apply_all(w)
w.data.materials.append(emat("WindowTeal", (0.25, 0.95, 1.0), 4.0)); lights.append(w)
for p in [(-7.4, 0, 3.0), (3.6, -2.4, 2.0), (-1.4, 2.6, 1.9)]:
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.14, segments=16, ring_count=8, location=p)
    s = bpy.context.active_object; s.data.materials.append(emat("BeaconRed", (1.0, 0.04, 0.02), 12.0)); lights.append(s)
active(lights[0])
for l in lights: l.select_set(True)
bpy.ops.object.join(); bpy.context.active_object.name = "Wreck_Lights"

# Bent solar wing.
bpy.ops.mesh.primitive_cube_add(size=1, location=(-3.5, 3.5, 7.0))
wing = bpy.context.active_object; wing.name = "Wreck_Solar"; wing.scale = (2.4, 7.0, 0.06); apply_all(wing)
active(wing); bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT"); bpy.ops.mesh.subdivide(number_cuts=16); bpy.ops.object.mode_set(mode="OBJECT")
sd = wing.modifiers.new("bend", "SIMPLE_DEFORM"); sd.deform_method = "BEND"; sd.angle = math.radians(55); sd.deform_axis = "X"
apply_all(wing); wing.rotation_euler = (math.radians(-25), math.radians(10), 0)
sm = bpy.data.materials.new("SolarPanel"); sb = sm.node_tree.nodes["Principled BSDF"]
sb.inputs["Base Color"].default_value = (0.02, 0.03, 0.08, 1); sb.inputs["Metallic"].default_value = 0.7; sb.inputs["Roughness"].default_value = 0.3
wing.data.materials.append(sm)

# Collision: a plain closed cylinder + cap, no tear (the game uses it as a trimesh collider and hides it).
bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=3.05, depth=16.5, location=(-0.75, 0, 0), rotation=(0, math.radians(90), 0))
bpy.context.active_object.name = "COL_Wreck"

# ---------------------------------------------------------------------------------------------
# UVs and bake.
active(hullj)
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.002, area_weight=1.0, scale_to_bounds=True)
bpy.ops.object.mode_set(mode="OBJECT")
print("hull verts", len(hullj.data.vertices), "faces", len(hullj.data.polygons))

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
scene.cycles.samples = 4
scene.render.bake.margin = 8

nt = hull_src.node_tree
out = nt.nodes["Material Output"]; bsdf = nt.nodes["Principled BSDF"]
target = nt.nodes.new("ShaderNodeTexImage")
nt.nodes.active = target
emit = nt.nodes.new("ShaderNodeEmission")


def bake(name, kind, socket=None, noncolor=True):
    im = bpy.data.images.new(f"Wreck_{name}", BAKE, BAKE, alpha=False, float_buffer=False)
    if noncolor: im.colorspace_settings.name = "Non-Color"
    target.image = im; nt.nodes.active = target
    if socket is not None:
        nt.links.new(socket, emit.inputs["Color"]); nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
        bpy.ops.object.bake(type="EMIT")
    else:
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        bpy.ops.object.bake(type=kind, normal_space="TANGENT")
    path = os.path.join(OUT, f"Wreck_{name}.png")
    im.filepath_raw = path; im.file_format = "PNG"; im.save()
    print("baked", name)
    return im


active(hullj)
col_img = bake("BaseColor", "EMIT", chans["color"], noncolor=False)
rough_img = bake("Roughness", "EMIT", chans["rough"])
metal_img = bake("Metallic", "EMIT", chans["metal"])
nrm_img = bake("Normal", "NORMAL")

# Final hull material: plain PBR from the baked maps (what glTF can carry).
fm = bpy.data.materials.new("WreckHull"); fnt = fm.node_tree; fb = fnt.nodes["Principled BSDF"]
def t(img, noncolor):
    n = fnt.nodes.new("ShaderNodeTexImage"); n.image = img
    if noncolor: img.colorspace_settings.name = "Non-Color"
    return n
c = t(col_img, False); fnt.links.new(c.outputs["Color"], fb.inputs["Base Color"])
# glTF wants roughness in G and metallic in B of one texture: combine.
sepr = fnt.nodes.new("ShaderNodeSeparateColor"); r_ = t(rough_img, True); m_ = t(metal_img, True)
fnt.links.new(r_.outputs["Color"], fb.inputs["Roughness"]); fnt.links.new(m_.outputs["Color"], fb.inputs["Metallic"])
n_ = t(nrm_img, True); nmap = fnt.nodes.new("ShaderNodeNormalMap"); fnt.links.new(n_.outputs["Color"], nmap.inputs["Color"]); fnt.links.new(nmap.outputs["Normal"], fb.inputs["Normal"])
hullj.data.materials.clear(); hullj.data.materials.append(fm)
bpy.data.objects.remove(cut)

# Export.
bpy.ops.object.select_all(action="SELECT")
glb = os.path.join(OUT, "wreck.glb")
kw = dict(filepath=glb, export_format="GLB", use_selection=True, export_apply=True, export_yup=True)
try:
    bpy.ops.export_scene.gltf(**kw, export_image_format="WEBP", export_image_quality=88)
except TypeError:
    bpy.ops.export_scene.gltf(**kw)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "wreck_asset.blend"))
print("@@DONE@@", glb, os.path.getsize(glb))
