# Biocrash style frame: the crash site, "realistic but exaggerated, gritty, glowing alien".
# Run: blender -b -P bc_style_frame.py -- <out_dir>
# Free CC0 textures from Poly Haven (already downloaded to the asset library).
import bpy, bmesh, math, random, os, sys
from mathutils import Vector, noise, Euler

random.seed(7)
TEX = r"C:\Users\manri\OneDrive\AssetLibrary\Textures\_ThirdParty\PolyHaven"
OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else r"C:\Users\manri\OneDrive\AssetLibrary\3D\Environment\bc_crash_site"
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection


def link(obj):
    col.objects.link(obj)
    return obj


def find(folder, key):
    d = os.path.join(TEX, folder)
    for f in os.listdir(d):
        if key in f.lower():
            return os.path.join(d, f)
    return None


def tex_node(nt, path, noncolor, vec, proj_blend=0.25):
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = bpy.data.images.load(path, check_existing=True)
    if noncolor:
        n.image.colorspace_settings.name = "Non-Color"
    n.projection = "BOX"
    n.projection_blend = proj_blend
    nt.links.new(vec, n.inputs["Vector"])
    return n


def pbr(name, folder, scale=1.0, tint=None, metal=None, rough_mul=1.0, bump=0.6):
    """Box-projected PBR material in object space (no UVs needed). Returns (material, nodes dict)."""
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (scale, scale, scale)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    v = mp.outputs["Vector"]
    diff = tex_node(nt, find(folder, "_diff_"), False, v)
    c = diff.outputs["Color"]
    if tint:
        mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        nt.links.new(c, mix.inputs["A"]); mix.inputs["B"].default_value = (*tint, 1)
        c = mix.outputs["Result"]
    ao = find(folder, "_ao_")
    if ao:
        aon = tex_node(nt, ao, True, v)
        mul = nt.nodes.new("ShaderNodeMix"); mul.data_type = "RGBA"; mul.blend_type = "MULTIPLY"
        mul.inputs["Factor"].default_value = 0.8
        nt.links.new(c, mul.inputs["A"]); nt.links.new(aon.outputs["Color"], mul.inputs["B"])
        c = mul.outputs["Result"]
    nt.links.new(c, bsdf.inputs["Base Color"])
    r = find(folder, "_rough_")
    if r:
        rn = tex_node(nt, r, True, v)
        mr = nt.nodes.new("ShaderNodeMath"); mr.operation = "MULTIPLY"; mr.inputs[1].default_value = rough_mul
        nt.links.new(rn.outputs["Color"], mr.inputs[0]); nt.links.new(mr.outputs[0], bsdf.inputs["Roughness"])
    me = find(folder, "_metal_")
    if me:
        mn = tex_node(nt, me, True, v); nt.links.new(mn.outputs["Color"], bsdf.inputs["Metallic"])
    elif metal is not None:
        bsdf.inputs["Metallic"].default_value = metal
    n = find(folder, "_nor_gl_")
    nm = None
    if n:
        nn = tex_node(nt, n, True, v)
        nm = nt.nodes.new("ShaderNodeNormalMap"); nm.inputs["Strength"].default_value = 1.2
        nt.links.new(nn.outputs["Color"], nm.inputs["Color"])
    dp = find(folder, "_disp_")
    if dp:
        dn = tex_node(nt, dp, True, v)
        bp = nt.nodes.new("ShaderNodeBump"); bp.inputs["Strength"].default_value = bump; bp.inputs["Distance"].default_value = 0.05
        nt.links.new(dn.outputs["Color"], bp.inputs["Height"])
        if nm: nt.links.new(nm.outputs["Normal"], bp.inputs["Normal"])
        nt.links.new(bp.outputs["Normal"], bsdf.inputs["Normal"])
    elif nm:
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return m, {"nt": nt, "bsdf": bsdf, "color": c, "vec": v}


def emissive(name, color, strength):
    m = bpy.data.materials.new(name)
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Emission Color"].default_value = (*color, 1)
    b.inputs["Emission Strength"].default_value = strength
    return m


def mesh_obj(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    return link(bpy.data.objects.new(name, me))


def smooth(obj, angle=40):
    for p in obj.data.polygons:
        p.use_smooth = True
    mod = obj.modifiers.new("smooth", "SMOOTH_BY_ANGLE") if hasattr(bpy.types, "SmoothByAngleModifier") else None
    return obj


# ---------------------------------------------------------------------------------------------
# Terrain: rolling alien ground with a gouged crash trench leading to the wreck.
WRECK = Vector((0, 0, 0))
TRENCH_DIR = Vector((1, 0.35, 0)).normalized()


def trench_amount(x, y):
    p = Vector((x, y, 0)) - WRECK
    along = p.dot(TRENCH_DIR)
    side = (p - TRENCH_DIR * along).length
    if along < -4 or along > 70:
        return 0.0
    w = 4.5 + along * 0.05
    depth = 1.6 * max(0, 1 - along / 70) * max(0.0, 1 - (side / w) ** 2)
    berm = 0.7 * math.exp(-((side - w) / 2.0) ** 2) * max(0, 1 - along / 70)
    return -depth + berm


def height(x, y):
    h = noise.noise(Vector((x * 0.025, y * 0.025, 0.3))) * 3.0
    h += noise.noise(Vector((x * 0.09, y * 0.09, 1.7))) * 0.7
    h += noise.noise(Vector((x * 0.4, y * 0.4, 4.1))) * 0.12
    return h + trench_amount(x, y)


bm = bmesh.new()
bmesh.ops.create_grid(bm, x_segments=260, y_segments=260, size=70)
scorch = bm.loops.layers.color.new("scorch")
for v in bm.verts:
    v.co.z = height(v.co.x, v.co.y)
for f in bm.faces:
    for l in f.loops:
        x, y = l.vert.co.x, l.vert.co.y
        t = min(1.0, abs(trench_amount(x, y)) * 0.9 + max(0, 1 - (Vector((x, y, 0)) - WRECK).length / 16))
        l[scorch] = (t, t, t, 1)
ground = mesh_obj("Ground", bm)
smooth(ground)

g_mud, gm = pbr("Ground_alien", "mud_forest", scale=0.35, tint=(0.35, 0.33, 0.42), rough_mul=1.0)
g_burn, _ = pbr("tmp_burn", "burned_ground_01", scale=0.3)
# Blend: burned ground in the trench and around the wreck, alien mud elsewhere (one material, mask = vertex colour).
nt = gm["nt"]
attr = nt.nodes.new("ShaderNodeVertexColor"); attr.layer_name = "scorch"
burn_diff = tex_node(nt, find("burned_ground_01", "_diff_"), False, gm["vec"])
mixc = nt.nodes.new("ShaderNodeMix"); mixc.data_type = "RGBA"
nt.links.new(attr.outputs["Color"], mixc.inputs["Factor"])
nt.links.new(gm["color"], mixc.inputs["A"]); nt.links.new(burn_diff.outputs["Color"], mixc.inputs["B"])
nt.links.new(mixc.outputs["Result"], gm["bsdf"].inputs["Base Color"])
bpy.data.materials.remove(g_burn)
ground.data.materials.append(g_mud)

# ---------------------------------------------------------------------------------------------
# The wreck: a station habitat module, torn open at one end, half buried at the end of the trench.
hull_m, hm = pbr("Hull_plates", "metal_plate_02", scale=0.45, tint=(0.45, 0.47, 0.5))
# Grime and scorch on the hull: rust texture mixed in by a noise mask.
nt = hm["nt"]
rust = tex_node(nt, find("rusty_metal_02", "_diff_"), False, hm["vec"])
nz = nt.nodes.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 1.6; nz.inputs["Detail"].default_value = 8
nt.links.new(hm["vec"], nz.inputs["Vector"])
ramp = nt.nodes.new("ShaderNodeValToRGB"); ramp.color_ramp.elements[0].position = 0.58; ramp.color_ramp.elements[1].position = 0.72
nt.links.new(nz.outputs["Fac"], ramp.inputs["Fac"])
mx = nt.nodes.new("ShaderNodeMix"); mx.data_type = "RGBA"
nt.links.new(ramp.outputs["Color"], mx.inputs["Factor"]); nt.links.new(hm["color"], mx.inputs["A"]); nt.links.new(rust.outputs["Color"], mx.inputs["B"])
nt.links.new(mx.outputs["Result"], hm["bsdf"].inputs["Base Color"])
dark_m = emissive("Interior_dark", (0.01, 0.01, 0.012), 0.0)
dark_m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
glow_teal = emissive("Station_teal", (0.25, 0.95, 1.0), 4.0)
warn = emissive("Warning_red", (1.0, 0.04, 0.02), 12.0)
panel_m, _ = pbr("Panel_paint", "painted_metal_shutter", scale=0.8, tint=(0.95, 0.95, 0.95))

wreck = bpy.data.objects.new("Wreck", None); link(wreck)
wreck.location = (0, 0, 0.6)
wreck.rotation_euler = Euler((math.radians(8), math.radians(-14), math.atan2(TRENCH_DIR.y, TRENCH_DIR.x) + math.radians(6)))

# Main hull cylinder along local X.
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=3.0, depth=15, location=(0, 0, 0), rotation=(0, math.radians(90), 0))
hull = bpy.context.active_object; hull.name = "Hull"
bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
hull.data.materials.append(hull_m)
hull.parent = wreck
sol = hull.modifiers.new("shell", "SOLIDIFY"); sol.thickness = 0.18
bev = hull.modifiers.new("bevel", "BEVEL"); bev.width = 0.04; bev.segments = 2
# Torn end: boolean away a jagged blob at +X.
bm = bmesh.new()
bmesh.ops.create_icosphere(bm, subdivisions=5, radius=3.6)
for v in bm.verts:
    d = noise.noise(v.co * 0.7 + Vector((3, 1, 2))) * 1.2 + noise.noise(v.co * 2.2) * 0.3 + noise.noise(v.co * 7) * 0.06
    v.co *= 1 + d * 0.35
cut = mesh_obj("TearCutter", bm)
cut.location = (7.6, 0.4, 0.6); cut.parent = hull if False else None
cut.parent = wreck; cut.location = (7.4, 0.2, 1.0)
boo = hull.modifiers.new("tear", "BOOLEAN"); boo.object = cut; boo.operation = "DIFFERENCE"; boo.solver = "EXACT"
hull.modifiers.move(hull.modifiers.find("tear"), 0)
cut.hide_render = True; cut.hide_viewport = True
# Interior: a dark inner cylinder so the tear shows a black cavity.
bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=2.75, depth=14.6, rotation=(0, math.radians(90), 0))
inner = bpy.context.active_object; inner.name = "Interior"; inner.data.materials.append(dark_m); inner.parent = wreck
ib = inner.modifiers.new("tear", "BOOLEAN"); ib.object = cut; ib.operation = "DIFFERENCE"; ib.solver = "EXACT"
for f in inner.data.polygons:
    f.flip() if False else None
bpy.context.view_layer.objects.active = inner
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT"); bpy.ops.mesh.flip_normals(); bpy.ops.object.mode_set(mode="OBJECT")

# Structural ribs and end ring.
for i, x in enumerate([-6.8, -4.2, -1.4, 1.4, 4.0]):
    bpy.ops.mesh.primitive_torus_add(major_radius=3.12, minor_radius=0.16, major_segments=48, minor_segments=8, location=(x, 0, 0), rotation=(0, math.radians(90), 0))
    rib = bpy.context.active_object; rib.name = f"Rib{i}"; rib.data.materials.append(panel_m); rib.parent = wreck
    rib.scale = (1, 1, 1.0)
# Window strip (teal light still on inside the station).
bpy.ops.mesh.primitive_cube_add(size=1, location=(-2.8, -3.02, 0.9))
win = bpy.context.active_object; win.scale = (4.5, 0.08, 0.35); win.data.materials.append(glow_teal); win.parent = wreck
# Warning beacons.
for p in [(-7.4, 0, 3.0), (3.6, -2.4, 2.0), (-1.4, 2.6, 1.9)]:
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.14, location=p)
    b = bpy.context.active_object; b.data.materials.append(warn); b.parent = wreck
    l = bpy.data.lights.new("beacon", "POINT"); l.energy = 120; l.color = (1, 0.05, 0.03); l.shadow_soft_size = 0.2
    lo = bpy.data.objects.new("beaconL", l); lo.location = p; lo.parent = wreck; link(lo)
# Bent solar wing on a mast.
bpy.ops.mesh.primitive_cylinder_add(radius=0.12, depth=5, location=(-3.5, 0, 4.8))
mast = bpy.context.active_object; mast.data.materials.append(panel_m); mast.parent = wreck
bpy.ops.mesh.primitive_cube_add(size=1, location=(-3.5, 3.5, 7.0))
wing = bpy.context.active_object; wing.scale = (2.4, 7.0, 0.06); wing.parent = wreck
sd = wing.modifiers.new("bend", "SIMPLE_DEFORM"); sd.deform_method = "BEND"; sd.angle = math.radians(55); sd.deform_axis = "X"
wing.rotation_euler = (math.radians(-25), math.radians(10), 0)
solar = bpy.data.materials.new("Solar"); sb = solar.node_tree.nodes["Principled BSDF"]
sb.inputs["Base Color"].default_value = (0.02, 0.03, 0.08, 1); sb.inputs["Metallic"].default_value = 0.6; sb.inputs["Roughness"].default_value = 0.25
br = solar.node_tree.nodes.new("ShaderNodeTexBrick"); br.inputs["Scale"].default_value = 18
solar.node_tree.links.new(br.outputs["Fac"], sb.inputs["Roughness"])
wing.data.materials.append(solar)

# Smoke from the torn end (EEVEE volume).
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=0.5, location=(8.5, 3.0, 5))
smoke = bpy.context.active_object; smoke.name = "Smoke"; smoke.scale = (6, 6, 10)
sm = bpy.data.materials.new("Smoke"); snt = sm.node_tree
for n in list(snt.nodes):
    if n.type == "BSDF_PRINCIPLED": snt.nodes.remove(n)
pv = snt.nodes.new("ShaderNodeVolumePrincipled"); pv.inputs["Color"].default_value = (0.25, 0.24, 0.26, 1)
tc = snt.nodes.new("ShaderNodeTexCoord"); nzs = snt.nodes.new("ShaderNodeTexNoise"); nzs.inputs["Scale"].default_value = 2.2; nzs.inputs["Detail"].default_value = 6
snt.links.new(tc.outputs["Generated"], nzs.inputs["Vector"])
grad = snt.nodes.new("ShaderNodeTexGradient"); grad.gradient_type = "SPHERICAL"; snt.links.new(tc.outputs["Object"], grad.inputs["Vector"])
mm = snt.nodes.new("ShaderNodeMath"); mm.operation = "MULTIPLY"
snt.links.new(nzs.outputs["Fac"], mm.inputs[0])
pw = snt.nodes.new("ShaderNodeMath"); pw.operation = "POWER"; pw.inputs[1].default_value = 2.5
snt.links.new(grad.outputs["Fac"], pw.inputs[0]); snt.links.new(pw.outputs[0], mm.inputs[1])
mm2 = snt.nodes.new("ShaderNodeMath"); mm2.operation = "MULTIPLY"; mm2.inputs[1].default_value = 0.9
snt.links.new(mm.outputs[0], mm2.inputs[0]); snt.links.new(mm2.outputs[0], pv.inputs["Density"])
snt.links.new(pv.outputs["Volume"], snt.nodes["Material Output"].inputs["Volume"])
smoke.data.materials.append(sm)

# Debris plates scattered down the trench.
for i in range(26):
    along = random.uniform(3, 40); side = random.gauss(0, 3.5)
    p = WRECK + TRENCH_DIR * along + Vector((-TRENCH_DIR.y, TRENCH_DIR.x, 0)) * side
    bpy.ops.mesh.primitive_cube_add(size=1, location=(p.x, p.y, height(p.x, p.y) + 0.05))
    d = bpy.context.active_object
    d.scale = (random.uniform(0.4, 1.8), random.uniform(0.3, 1.2), 0.04)
    d.rotation_euler = (random.uniform(-0.5, 0.5), random.uniform(-0.5, 0.5), random.uniform(0, 6.28))
    sdm = d.modifiers.new("bend", "SIMPLE_DEFORM"); sdm.deform_method = "BEND"; sdm.angle = random.uniform(-0.8, 0.8)
    d.data.materials.append(hull_m if i % 3 else panel_m)

# ---------------------------------------------------------------------------------------------
# Rocks.
rock_m, _ = pbr("Rock", "dark_rock_02", scale=0.5, tint=(0.7, 0.68, 0.75))
for i in range(22):
    a = random.uniform(0, 6.28); r = random.uniform(10, 45)
    x, y = math.cos(a) * r, math.sin(a) * r
    pp = Vector((x, y, 0)); al = pp.dot(TRENCH_DIR); sd_ = (pp - TRENCH_DIR * al).length
    if -5 < al < 40 and sd_ < 12: continue  # keep the view up the trench clear
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=4, radius=1.0)
    s = random.uniform(0.4, 2.6); seed = random.uniform(0, 100)
    for v in bm.verts:
        n = noise.noise(v.co * 1.3 + Vector((seed, 0, 0))) * 0.45 + noise.noise(v.co * 4 + Vector((0, seed, 0))) * 0.08
        v.co *= 1 + n
        v.co.z *= 0.65
    ro = mesh_obj(f"Rock{i}", bm); smooth(ro)
    ro.location = (x, y, height(x, y) + s * 0.15); ro.scale = (s, s * random.uniform(0.7, 1.2), s)
    ro.rotation_euler = (0, 0, random.uniform(0, 6.28))
    ro.data.materials.append(rock_m)

# ---------------------------------------------------------------------------------------------
# Alien flora: tall twisted stalks, drooping bell caps with glowing veins, hanging luminous tendrils,
# and clusters of translucent glowing bulbs. Dark bodies; the light comes from inside them.
def bell_material(name, body, vein):
    m = bpy.data.materials.new(name); nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    vor = nt.nodes.new("ShaderNodeTexVoronoi"); vor.feature = "DISTANCE_TO_EDGE"; vor.inputs["Scale"].default_value = 1.4
    warp = nt.nodes.new("ShaderNodeTexNoise"); warp.inputs["Scale"].default_value = 2.5; warp.inputs["Detail"].default_value = 4
    nt.links.new(tc.outputs["Object"], warp.inputs["Vector"])
    wadd = nt.nodes.new("ShaderNodeVectorMath"); wadd.operation = "MULTIPLY_ADD"; wadd.inputs[1].default_value = (0.6, 0.6, 0.6)
    nt.links.new(warp.outputs["Color"], wadd.inputs[0]); nt.links.new(tc.outputs["Object"], wadd.inputs[2])
    nt.links.new(wadd.outputs["Vector"], vor.inputs["Vector"])
    veins = nt.nodes.new("ShaderNodeValToRGB"); veins.color_ramp.elements[0].position = 0.0; veins.color_ramp.elements[0].color = (1, 1, 1, 1)
    veins.color_ramp.elements[1].position = 0.022; veins.color_ramp.elements[1].color = (0, 0, 0, 1)
    nt.links.new(vor.outputs["Distance"], veins.inputs["Fac"])
    nz = nt.nodes.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 4; nz.inputs["Detail"].default_value = 12
    nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
    base = nt.nodes.new("ShaderNodeMix"); base.data_type = "RGBA"
    base.inputs["A"].default_value = (*body, 1); base.inputs["B"].default_value = (body[0] * 0.3, body[1] * 0.3, body[2] * 0.3, 1)
    nt.links.new(nz.outputs["Fac"], base.inputs["Factor"]); nt.links.new(base.outputs["Result"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.3
    b.inputs["Subsurface Weight"].default_value = 0.4; b.inputs["Subsurface Radius"].default_value = (0.3, 0.8, 0.7)
    b.inputs["Emission Color"].default_value = (*vein, 1)
    pulse = nt.nodes.new("ShaderNodeTexNoise"); pulse.inputs["Scale"].default_value = 1.2
    nt.links.new(tc.outputs["Object"], pulse.inputs["Vector"])
    pr_ = nt.nodes.new("ShaderNodeValToRGB"); pr_.color_ramp.elements[0].position = 0.4; pr_.color_ramp.elements[1].position = 0.65
    nt.links.new(pulse.outputs["Fac"], pr_.inputs["Fac"])
    vm = nt.nodes.new("ShaderNodeMath"); vm.operation = "MULTIPLY"
    nt.links.new(veins.outputs["Color"], vm.inputs[0]); nt.links.new(pr_.outputs["Color"], vm.inputs[1])
    em = nt.nodes.new("ShaderNodeMath"); em.operation = "MULTIPLY"; em.inputs[1].default_value = 3.5
    nt.links.new(vm.outputs[0], em.inputs[0]); nt.links.new(em.outputs[0], b.inputs["Emission Strength"])
    bmp = nt.nodes.new("ShaderNodeBump"); bmp.inputs["Strength"].default_value = 0.5
    nt.links.new(nz.outputs["Fac"], bmp.inputs["Height"]); nt.links.new(bmp.outputs["Normal"], b.inputs["Normal"])
    return m


stalk_m = bpy.data.materials.new("Stalk"); sbn = stalk_m.node_tree.nodes["Principled BSDF"]
sbn.inputs["Base Color"].default_value = (0.08, 0.07, 0.09, 1); sbn.inputs["Roughness"].default_value = 0.35
sbn.inputs["Subsurface Weight"].default_value = 0.5; sbn.inputs["Subsurface Radius"].default_value = (0.2, 0.9, 0.7)
snz = stalk_m.node_tree.nodes.new("ShaderNodeTexWave"); snz.inputs["Scale"].default_value = 2; snz.wave_profile = "SAW"; snz.bands_direction = "Z"
snz.inputs["Distortion"].default_value = 6
sbm = stalk_m.node_tree.nodes.new("ShaderNodeBump"); sbm.inputs["Strength"].default_value = 0.6
stalk_m.node_tree.links.new(snz.outputs["Fac"], sbm.inputs["Height"]); stalk_m.node_tree.links.new(sbm.outputs["Normal"], sbn.inputs["Normal"])
tendril_m = emissive("Tendril", (0.2, 1.0, 0.65), 1.1); tendril_m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.02, 0.05, 0.04, 1)
bulb_m = bpy.data.materials.new("Bulb"); bb = bulb_m.node_tree.nodes["Principled BSDF"]
bb.inputs["Base Color"].default_value = (0.6, 0.9, 1.0, 1); bb.inputs["Roughness"].default_value = 0.1
bb.inputs["Transmission Weight"].default_value = 0.6; bb.inputs["Emission Color"].default_value = (0.35, 0.8, 1.0, 1); bb.inputs["Emission Strength"].default_value = 4.0
bells = [bell_material(f"Bell{i}", b, v) for i, (b, v) in enumerate([
    ((0.12, 0.04, 0.16), (0.25, 1.0, 0.7)), ((0.05, 0.05, 0.14), (0.4, 0.6, 1.0)), ((0.16, 0.03, 0.05), (1.0, 0.3, 0.45)), ((0.03, 0.09, 0.08), (0.6, 1.0, 0.3))])]


def tube(points, r, mat):
    cu = bpy.data.curves.new("tube", "CURVE"); cu.dimensions = "3D"; cu.bevel_depth = r; cu.bevel_resolution = 1
    sp_ = cu.splines.new("NURBS"); sp_.points.add(len(points) - 1)
    for i, p in enumerate(points):
        sp_.points[i].co = (*p, 1)
        sp_.points[i].radius = 1 - i / len(points) * 0.8
    sp_.use_endpoint_u = True; sp_.order_u = 3
    o = link(bpy.data.objects.new("Tendril", cu)); o.data.materials.append(mat)
    return o


def alien_fungus(x, y, h, cap_r, mat, lean=0.12):
    seg = 18; rings = []
    bm = bmesh.new()
    r0 = cap_r * 0.09
    steps = 14
    for i in range(steps + 1):
        t = i / steps
        tw = t * 2.4  # twist
        bulge = 1.6 * math.exp(-((t - 0.0) / 0.12) ** 2) + 0.25 * math.sin(t * 9) + 1.0 - 0.35 * t
        off = Vector((math.sin(t * 3 + x) * 0.25 * cap_r * 0.1, math.cos(t * 2.3 + y) * 0.25 * cap_r * 0.1, 0))
        ring = []
        for k in range(seg):
            a = k / seg * 6.283 + tw
            wob = 1 + 0.18 * math.sin(a * 3 + t * 10)
            ring.append(bm.verts.new((off.x + math.cos(a) * r0 * bulge * wob, off.y + math.sin(a) * r0 * bulge * wob, t * h)))
        rings.append(ring)
    for i in range(steps):
        for k in range(seg):
            bm.faces.new((rings[i][k], rings[i][(k + 1) % seg], rings[i + 1][(k + 1) % seg], rings[i + 1][k]))
    st = mesh_obj("Stalk", bm); smooth(st); st.data.materials.append(stalk_m)
    st.modifiers.new("sub", "SUBSURF").render_levels = 2
    # Bell cap: a dome that droops past the horizontal into a skirt.
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=cap_r, location=(0, 0, 0))
    cap = bpy.context.active_object
    for v in cap.data.vertices:
        co = v.co
        z = co.z / cap_r
        if z < -0.35:  # cut away the bottom: open bell
            co.z = -0.35 * cap_r
            co.x *= 1.05; co.y *= 1.05
        co.z = co.z * (0.85 if z > 0 else 1.4)
        co.x *= 1 + 0.08 * math.sin(math.atan2(co.y, co.x) * 7)
        co.y *= 1 + 0.08 * math.sin(math.atan2(co.y, co.x) * 7)
    cap.location = (off.x, off.y, h + cap_r * 0.25); cap.data.materials.append(mat); smooth(cap)
    sol = cap.modifiers.new("shell", "SOLIDIFY"); sol.thickness = 0.06
    parts = [st, cap]
    # Hanging tendrils from the rim, glowing.
    n = int(10 + cap_r * 5)
    for k in range(n):
        a = k / n * 6.283 + random.uniform(-0.1, 0.1)
        rr = cap_r * random.uniform(0.75, 1.0)
        top = Vector((off.x + math.cos(a) * rr, off.y + math.sin(a) * rr, h + cap_r * 0.25 - 0.35 * cap_r * 1.4))
        L = random.uniform(0.4, 1.0) * h * 0.55
        pts = [top + Vector((math.sin(j * 1.3 + k) * 0.15 * j, math.cos(j + k) * 0.15 * j, -L * j / 5)) for j in range(6)]
        parts.append(tube([tuple(p) for p in pts], random.uniform(0.006, 0.018) * cap_r, tendril_m))
    root = bpy.data.objects.new("Fungus", None); link(root)
    for o in parts: o.parent = root
    root.location = (x, y, height(x, y) - 0.2)
    root.rotation_euler = (random.uniform(-lean, lean), random.uniform(-lean, lean), random.uniform(0, 6.28))
    if cap_r > 2:
        L = bpy.data.lights.new("fglow", "POINT"); L.energy = 250 * cap_r; L.color = mat.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value[:3]
        L.shadow_soft_size = cap_r
        lo = bpy.data.objects.new("fglowL", L); lo.location = (off.x, off.y, h - cap_r * 0.2); lo.parent = root; link(lo)


def bulbs(x, y, n, s):
    bm = bmesh.new()
    for i in range(n):
        c = Vector((x + random.gauss(0, s), y + random.gauss(0, s), 0)); r = random.uniform(0.08, 0.35) * s
        c.z = height(c.x, c.y) + r * 0.6
        m = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=r)
        bmesh.ops.scale(bm, vec=(1, 1, random.uniform(1.0, 1.8)), verts=m["verts"])
        bmesh.ops.translate(bm, verts=m["verts"], vec=c)
    o = mesh_obj("Bulbs", bm); smooth(o); o.data.materials.append(bulb_m)
    L = bpy.data.lights.new("bulbL", "POINT"); L.energy = 60 * s; L.color = (0.35, 0.8, 1.0)
    lo = bpy.data.objects.new("bulbL", L); lo.location = (x, y, height(x, y) + 0.6); link(lo)


spots_xy = [(-14, 9, 13, 4.2), (-22, -6, 10, 3.4), (14, 16, 16, 5.0), (-9, -16, 8, 2.8), (26, -12, 12, 4.0), (-30, 14, 18, 5.2), (6, -24, 9, 3.2), (34, 20, 14, 4.4)]
for i, (x, y, h, cr) in enumerate(spots_xy):
    alien_fungus(x, y, h, cr, bells[i % 4])
for i in range(22):
    a = random.uniform(0, 6.28); r = random.uniform(5, 40)
    x, y = math.cos(a) * r, math.sin(a) * r
    if abs(trench_amount(x, y)) > 0.2: continue
    alien_fungus(x, y, random.uniform(0.8, 2.6), random.uniform(0.3, 0.8), bells[i % 4], lean=0.35)
for i in range(10):
    a = random.uniform(0, 6.28); r = random.uniform(6, 35)
    x, y = math.cos(a) * r, math.sin(a) * r
    if abs(trench_amount(x, y)) > 0.2: continue
    bulbs(x, y, random.randint(6, 16), random.uniform(0.6, 1.4))

# Spores: fewer, drifting low in the fog.
bm = bmesh.new()
for i in range(260):
    c = Vector((random.uniform(-40, 40), random.uniform(-40, 40), 0))
    c.z = height(c.x, c.y) + random.uniform(0.3, 5)
    m = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=random.uniform(0.015, 0.045))
    bmesh.ops.translate(bm, verts=m["verts"], vec=c)
sp = mesh_obj("Spores", bm); sp.data.materials.append(emissive("Spore", (0.4, 1.0, 0.75), 25))

# Something standing in the fog, far off, watching. Barely there.
bm = bmesh.new()
m = bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=0.22, radius2=0.12, depth=2.1)
bmesh.ops.translate(bm, verts=m["verts"], vec=(0, 0, 1.05))
m = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=0.16)
bmesh.ops.translate(bm, verts=m["verts"], vec=(0, 0, 2.3))
for side in (-1, 1):
    m = bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.05, radius2=0.03, depth=1.7)
    bmesh.ops.translate(bm, verts=m["verts"], vec=(side * 0.3, 0, 1.25))
fig = mesh_obj("Watcher", bm); fig.data.materials.append(emissive("Void", (0, 0, 0), 0.0))
fp = WRECK + TRENCH_DIR * -4 + Vector((-TRENCH_DIR.y, TRENCH_DIR.x, 0)) * 26
fig.location = (fp.x, fp.y, height(fp.x, fp.y) - 0.05)

# ---------------------------------------------------------------------------------------------
# Lighting: alien night falling. Black-green sky with a sickly band on the horizon, a huge banded planet,
# cold faint moonlight, low teal ground fog lit by the fungi. The wreck's red warning lights.
world = bpy.data.worlds.new("Night"); scene.world = world
wnt = world.node_tree
bg = wnt.nodes["Background"]
tcw = wnt.nodes.new("ShaderNodeTexCoord"); sep = wnt.nodes.new("ShaderNodeSeparateXYZ")
wnt.links.new(tcw.outputs["Generated"], sep.inputs["Vector"])
wr = wnt.nodes.new("ShaderNodeValToRGB")
wr.color_ramp.elements[0].position = 0.5; wr.color_ramp.elements[0].color = (0.06, 0.13, 0.08, 1)
wr.color_ramp.elements[1].position = 0.72; wr.color_ramp.elements[1].color = (0.002, 0.002, 0.006, 1)
e = wr.color_ramp.elements.new(0.55); e.color = (0.02, 0.04, 0.06, 1)
wnt.links.new(sep.outputs["Z"], wr.inputs["Fac"])
# Stars.
vs = wnt.nodes.new("ShaderNodeTexVoronoi"); vs.inputs["Scale"].default_value = 400
wnt.links.new(tcw.outputs["Generated"], vs.inputs["Vector"])
sr = wnt.nodes.new("ShaderNodeValToRGB"); sr.color_ramp.elements[0].position = 0.0; sr.color_ramp.elements[0].color = (1, 1, 1, 1)
sr.color_ramp.elements[1].position = 0.03; sr.color_ramp.elements[1].color = (0, 0, 0, 1)
wnt.links.new(vs.outputs["Distance"], sr.inputs["Fac"])
add = wnt.nodes.new("ShaderNodeMix"); add.data_type = "RGBA"; add.blend_type = "ADD"; add.inputs["Factor"].default_value = 0.6
wnt.links.new(wr.outputs["Color"], add.inputs["A"]); wnt.links.new(sr.outputs["Color"], add.inputs["B"])
wnt.links.new(add.outputs["Result"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 1.0
# The planet in the sky.
bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=90, location=(-420, 700, 260))
pl = bpy.context.active_object; pl.name = "Planet"
pm = bpy.data.materials.new("Planet"); pnt = pm.node_tree; pb = pnt.nodes["Principled BSDF"]
wv = pnt.nodes.new("ShaderNodeTexWave"); wv.bands_direction = "Z"; wv.inputs["Scale"].default_value = 2.2; wv.inputs["Distortion"].default_value = 9; wv.inputs["Detail"].default_value = 6
pr = pnt.nodes.new("ShaderNodeValToRGB"); pr.color_ramp.elements[0].color = (0.1, 0.05, 0.12, 1); pr.color_ramp.elements[1].color = (0.35, 0.45, 0.3, 1)
pnt.links.new(wv.outputs["Fac"], pr.inputs["Fac"]); pnt.links.new(pr.outputs["Color"], pb.inputs["Base Color"])
pnt.links.new(pr.outputs["Color"], pb.inputs["Emission Color"]); pb.inputs["Emission Strength"].default_value = 0.18
pl.data.materials.append(pm); smooth(pl)
# Thin high fog everywhere, plus a dense layer hugging the ground.
for name, loc, scl, dens, colr in [("Fog", (0, 0, 10), (160, 160, 40), 0.0012, (0.1, 0.2, 0.22)), ("GroundFog", (0, 0, 1.5), (160, 160, 6), 0.03, (0.25, 0.6, 0.55))]:
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    fog = bpy.context.active_object; fog.name = name; fog.scale = scl
    fm = bpy.data.materials.new(name); fnt = fm.node_tree
    fnt.nodes.remove(fnt.nodes["Principled BSDF"])
    fv = fnt.nodes.new("ShaderNodeVolumePrincipled"); fv.inputs["Color"].default_value = (*colr, 1); fv.inputs["Anisotropy"].default_value = 0.5
    if name == "GroundFog":  # thins out with height, patchy
        tcf = fnt.nodes.new("ShaderNodeTexCoord"); sepf = fnt.nodes.new("ShaderNodeSeparateXYZ"); fnt.links.new(tcf.outputs["Generated"], sepf.inputs["Vector"])
        inv = fnt.nodes.new("ShaderNodeMath"); inv.operation = "SUBTRACT"; inv.inputs[0].default_value = 1.0; fnt.links.new(sepf.outputs["Z"], inv.inputs[1])
        nzf = fnt.nodes.new("ShaderNodeTexNoise"); nzf.inputs["Scale"].default_value = 8; fnt.links.new(tcf.outputs["Generated"], nzf.inputs["Vector"])
        mf = fnt.nodes.new("ShaderNodeMath"); mf.operation = "MULTIPLY"; fnt.links.new(inv.outputs[0], mf.inputs[0]); fnt.links.new(nzf.outputs["Fac"], mf.inputs[1])
        mf2 = fnt.nodes.new("ShaderNodeMath"); mf2.operation = "MULTIPLY"; mf2.inputs[1].default_value = dens * 2.5
        fnt.links.new(mf.outputs[0], mf2.inputs[0]); fnt.links.new(mf2.outputs[0], fv.inputs["Density"])
    else:
        fv.inputs["Density"].default_value = dens
    fnt.links.new(fv.outputs["Volume"], fnt.nodes["Material Output"].inputs["Volume"])
    fog.data.materials.append(fm)

sun = bpy.data.lights.new("Moon", "SUN"); sun.energy = 0.3; sun.color = (0.45, 0.6, 1.0); sun.angle = math.radians(1)
so = bpy.data.objects.new("Moon", sun); link(so); so.rotation_euler = Euler((math.radians(55), 0, math.radians(-150)))

# Camera: player eye height, looking up the trench at the wreck.
cam = bpy.data.cameras.new("Cam"); cam.lens = 22
co = bpy.data.objects.new("Cam", cam); link(co); scene.camera = co
cpos = WRECK + TRENCH_DIR * 17 + Vector((-TRENCH_DIR.y, TRENCH_DIR.x, 0)) * -7
co.location = (cpos.x, cpos.y, height(cpos.x, cpos.y) + 1.7)
look = Vector((0, 0, 2.6)) - co.location
co.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()

# Render settings.
scene.render.engine = "BLENDER_EEVEE"
ee = scene.eevee
for attr, val in [("taa_render_samples", 64), ("use_shadows", True), ("use_raytracing", True), ("volumetric_tile_size", "4"), ("use_volumetric_shadows", True), ("volumetric_end", 120.0)]:
    try: setattr(ee, attr, val)
    except Exception as ex: print("skip", attr, ex)
scene.render.resolution_x = 1600; scene.render.resolution_y = 900
scene.view_settings.view_transform = "AgX"
try: scene.view_settings.look = "AgX - Medium High Contrast"
except Exception: pass
# Glow on the bright bits (bioluminescence, beacons).
try:
    ng = bpy.data.node_groups.new("Comp", "CompositorNodeTree"); scene.compositing_node_group = ng
    rl = ng.nodes.new("CompositorNodeRLayers")
    gl = ng.nodes.new("CompositorNodeGlare");
    try: gl.glare_type = "FOG_GLOW"
    except Exception:
        try: gl.inputs["Type"].default_value = "Fog Glow"
        except Exception as ex2: print("glare type skip", ex2)
    print("GLARE INPUTS", [i.name for i in gl.inputs])
    try: gl.inputs["Threshold"].default_value = 1.0; gl.inputs["Strength"].default_value = 0.6
    except Exception: pass
    out = ng.nodes.new("NodeGroupOutput") if False else None
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    go = ng.nodes.new("NodeGroupOutput")
    ng.links.new(rl.outputs["Image"], gl.inputs["Image"]); ng.links.new(gl.outputs["Image"], go.inputs[0])
except Exception as ex:
    print("compositor skipped", ex)

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "bc_crash_site_style.blend"))
scene.render.filepath = os.path.join(OUT, "style_frame_dusk.png")
bpy.ops.render.render(write_still=True)
cp2 = WRECK + TRENCH_DIR * 9 + Vector((-TRENCH_DIR.y, TRENCH_DIR.x, 0)) * -8
co.location = (cp2.x, cp2.y, height(cp2.x, cp2.y) + 1.7)
co.rotation_euler = (Vector((2, 0, 2.0)) - co.location).to_track_quat("-Z", "Y").to_euler()
scene.render.filepath = os.path.join(OUT, "style_frame_wreck.png")
bpy.ops.render.render(write_still=True)
print("@@DONE@@", scene.render.filepath)
