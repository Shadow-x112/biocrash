# Biocrash props v2: dark-alien, realistic-but-exaggerated. One glTF the game reads meshes from by name.
# Meshes (same names, sizes and origins as v1 so the game places them identically):
#   Stone, Stalkwood, Fiber, Sprout, Bulbs, Debris_1..3, Campfire_Stones, Campfire_Scrap, Campfire_Wood, Pack
# Pipeline per prop (Fiber excepted: thin blades keep vertex colour):
#   detailed high mesh (fracture cuts / voxel remesh / displacement) -> decimated game mesh -> UVs ->
#   Cycles bakes from the high mesh: base colour, roughness, metallic, emission (EMIT routing) and a tangent normal
#   that carries both the high geometry and procedural bump (cracks, fibres, panel seams, rivets, weave).
# Run: blender -b --factory-startup -P bc_props.py -- <out_dir> [bake_size]
import bpy, bmesh, math, random, os, sys
from mathutils import Vector, noise, Matrix

random.seed(5)
TEX = r"C:\Users\manri\OneDrive\AssetLibrary\Textures\_ThirdParty\PolyHaven"
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = ARGS[0] if ARGS else r"C:\Users\manri\OneDrive\AssetLibrary\3D\Props\bc_props"
BASE = int(ARGS[1]) if len(ARGS) > 1 else 1024
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection


# ---------------------------------------------------------------------------------------------------- helpers
def find(folder, key):
    d = os.path.join(TEX, folder)
    for f in os.listdir(d):
        if key in f.lower(): return os.path.join(d, f)


def bm_obj(name, bm, mat=None, vcol=None):
    if vcol is not None:
        layer = bm.loops.layers.color.new("Col")
        for f in bm.faces:
            for l in f.loops: l[layer] = vcol(l.vert.co)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); col.objects.link(o)
    if mat: me.materials.append(mat)
    for p in me.polygons: p.use_smooth = True
    return o


def merge_into(bm, part):
    tmp = bpy.data.meshes.new("t"); part.to_mesh(tmp); part.free(); bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)


def ctx(o):
    return bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o])


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


def remesh(o, voxel, smooth=2, disp=()):
    m = o.modifiers.new("rm", "REMESH"); m.mode = "VOXEL"; m.voxel_size = voxel; m.adaptivity = 0
    if smooth:
        s = o.modifiers.new("sm", "SMOOTH"); s.factor = 0.5; s.iterations = smooth
    displace(o, disp)


def displace(o, disp):
    for i, (kind, size, strength) in enumerate(disp):
        d = o.modifiers.new(f"d{i}", "DISPLACE"); d.texture = tex(kind, f"{o.name}_t{i}", size)
        d.texture_coords = "LOCAL"; d.strength = strength; d.mid_level = 0.5
    apply_all(o)
    for p in o.data.polygons: p.use_smooth = True


def low_from(hi, name, faces):
    lo = copy_obj(hi, name)
    dm = lo.modifiers.new("dec", "DECIMATE"); dm.ratio = min(1.0, faces / max(1, len(lo.data.polygons)))
    apply_all(lo)
    for p in lo.data.polygons: p.use_smooth = True
    return lo


def unwrap(o, margin=0.006):
    bpy.context.view_layer.objects.active = o
    for x in bpy.context.view_layer.objects: x.select_set(x == o)
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(64), island_margin=margin, area_weight=0.0, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def rock_bm(radius, seed, squash=0.7, sub=4, cuts=5):
    """A fractured stone: a lumpy icosphere with several flat fracture planes sliced off (reads as broken rock,
    not a noise blob), slightly squashed."""
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=radius)
    for v in bm.verts:
        n = noise.noise(v.co / radius * 1.1 + Vector((seed, 0, 0))) * 0.3 + noise.noise(v.co / radius * 3.2 + Vector((0, seed, 0))) * 0.07
        v.co *= 1 + n
    rnd = random.Random(int(seed * 100))
    for _ in range(cuts):
        nrm = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.6, 1))).normalized()
        d = radius * rnd.uniform(0.55, 0.85)
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=nrm * d, plane_no=nrm, clear_outer=True)
        edges = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        if edges:
            try: bmesh.ops.holes_fill(bm, edges=edges, sides=0)
            except Exception: pass
    for v in bm.verts: v.co.z *= squash
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    return bm


def trunk_bm(length, r0, r1, seed, rings=56, segs=40, ridges=11, torn=0.07):
    """Fungal trunk: fibrous ridges running along a slight twist, torn splintered ends."""
    bm = bmesh.new(); prev = None; first = None
    for j in range(rings + 1):
        t = j / rings; ring = []
        for i in range(segs):
            a = i / segs * math.tau + t * 1.4
            fib = 0.07 * math.sin(a * ridges + t * 5) + 0.02 * math.sin(a * ridges * 3.1 + seed)
            r = (r0 + (r1 - r0) * t) * (1 + fib + noise.noise(Vector((math.cos(a) * 2, math.sin(a) * 2, t * 6 + seed))) * 0.06)
            z = t * length - length / 2
            if j in (0, rings):
                z += noise.noise(Vector((math.cos(a) * 4, math.sin(a) * 4, seed + j))) * torn * 1.6 * (1 if j else -1)
            ring.append(bm.verts.new((math.cos(a) * r, math.sin(a) * r, z)))
        if prev:
            for i in range(segs): bm.faces.new((prev[i], prev[(i + 1) % segs], ring[(i + 1) % segs], ring[i]))
        else: first = ring
        prev = ring
    bm.faces.new(list(reversed(first))); bm.faces.new(prev)
    return bm


# ---------------------------------------------------------------------------------------------------- materials
class M:
    """Bake-source material builder: channels color / rough / metal / emit and a bump height, routed to an Emission
    output one at a time for EMIT bakes, and through a Principled BSDF's normal for the NORMAL bake."""
    def __init__(self, name):
        self.m = bpy.data.materials.new(name); self.nt = self.m.node_tree
        for n in list(self.nt.nodes):
            if n.type != "OUTPUT_MATERIAL": self.nt.nodes.remove(n)
        self.out = [n for n in self.nt.nodes if n.type == "OUTPUT_MATERIAL"][0]
        self.bsdf = self.n("ShaderNodeBsdfPrincipled"); self.em = self.n("ShaderNodeEmission")
        self.tc = self.n("ShaderNodeTexCoord"); self.geo = self.n("ShaderNodeNewGeometry")
        self.ch = {}

    def n(self, kind, **kw):
        node = self.nt.nodes.new(kind)
        for k, v in kw.items():
            if k.startswith("_"): setattr(node, k[1:], v)
            else: node.inputs[k].default_value = v
        return node

    def L(self, a, b): self.nt.links.new(a, b)

    def img(self, folder, key, scale, noncolor=True):
        p = find(folder, key)
        mp = self.n("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (scale, scale, scale)
        self.L(self.tc.outputs["Object"], mp.inputs["Vector"])
        t = self.n("ShaderNodeTexImage", _projection="BOX", _projection_blend=0.25)
        t.image = bpy.data.images.load(p, check_existing=True)
        if noncolor: t.image.colorspace_settings.name = "Non-Color"
        self.L(mp.outputs["Vector"], t.inputs["Vector"])
        return t

    def noise(self, scale, detail=6.0, rough=0.6):
        t = self.n("ShaderNodeTexNoise", Scale=scale, Detail=detail, Roughness=rough); self.L(self.tc.outputs["Object"], t.inputs["Vector"]); return t

    def voronoi(self, scale, feature="F1"):
        t = self.n("ShaderNodeTexVoronoi", Scale=scale, _feature=feature); self.L(self.tc.outputs["Object"], t.inputs["Vector"]); return t

    def ramp(self, sock, a, b, lo=0.0, hi=1.0):
        r = self.n("ShaderNodeMapRange"); self.L(sock, r.inputs["Value"])
        r.inputs["From Min"].default_value = a; r.inputs["From Max"].default_value = b
        r.inputs["To Min"].default_value = lo; r.inputs["To Max"].default_value = hi
        return r.outputs["Result"]

    def math(self, op, a, b=None, clamp=False):
        m = self.n("ShaderNodeMath", _operation=op, _use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None: continue
            if isinstance(v, (int, float)): m.inputs[i].default_value = v
            else: self.L(v, m.inputs[i])
        return m.outputs[0]

    def mix(self, fac, a, b, blend="MIX"):
        m = self.n("ShaderNodeMix", _data_type="RGBA", _blend_type=blend)
        for idx, v in ((0, fac), (6, a), (7, b)):
            if isinstance(v, (int, float)): m.inputs[idx].default_value = v
            elif isinstance(v, tuple): m.inputs[idx].default_value = (*v, 1) if len(v) == 3 else v
            else: self.L(v, m.inputs[idx])
        return m.outputs[2]

    def lerp(self, fac, a, b):
        return self.math("ADD", self.math("MULTIPLY", self.math("SUBTRACT", 1.0, fac), a), self.math("MULTIPLY", fac, b))

    def pointy(self, lo=0.47, hi=0.56):
        return self.ramp(self.geo.outputs["Pointiness"], lo, hi)  # 0 in cavities, 1 on sharp edges (Cycles)

    def finish(self, color, rough, metal=0.0, emit=None, height=None, bump=0.4, dist=0.004):
        if height is not None:
            b = self.n("ShaderNodeBump", Strength=bump, Distance=dist); self.L(height, b.inputs["Height"]); self.L(b.outputs["Normal"], self.bsdf.inputs["Normal"])
        def val(v):
            if isinstance(v, (int, float)):
                c = self.n("ShaderNodeValue"); c.outputs[0].default_value = v; return c.outputs[0]
            if isinstance(v, tuple):
                c = self.n("ShaderNodeRGB"); c.outputs[0].default_value = (*v, 1); return c.outputs[0]
            return v
        self.ch = {"color": val(color), "rough": val(rough), "metal": val(metal), "emit": val(emit if emit is not None else (0, 0, 0))}
        self.L(self.em.outputs["Emission"], self.out.inputs["Surface"])
        return self


# ---------------------------------------------------------------------------------------------------- bake
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
scene.render.bake.margin = 10
scene.render.bake.use_selected_to_active = True
FINAL = []  # (low object, hide-from-export list)


def bake(name, lo, hi, mat, size, ext, metal=False, emit=True, keep_vcol=False):
    hi.data.materials.clear(); hi.data.materials.append(mat.m)
    bm_ = bpy.data.materials.new(name + "_Bake"); target = bm_.node_tree.nodes.new("ShaderNodeTexImage"); bm_.node_tree.nodes.active = target
    lo.data.materials.clear(); lo.data.materials.append(bm_)
    scene.render.bake.cage_extrusion = ext; scene.render.bake.max_ray_distance = ext * 2.5
    imgs = {}
    def run(chan, noncolor):
        im = bpy.data.images.new(f"{name}_{chan}", size, size, alpha=False); target.image = im
        if noncolor: im.colorspace_settings.name = "Non-Color"
        for o in bpy.context.view_layer.objects: o.select_set(o in (lo, hi))
        bpy.context.view_layer.objects.active = lo
        if chan == "normal":
            mat.L(mat.bsdf.outputs["BSDF"], mat.out.inputs["Surface"])
            bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT")
            mat.L(mat.em.outputs["Emission"], mat.out.inputs["Surface"])
        else:
            mat.L(mat.ch[chan], mat.em.inputs["Color"])
            bpy.ops.object.bake(type="EMIT")
        imgs[chan] = im; print("baked", name, chan)
    run("color", False); run("rough", True)
    if metal: run("metal", True)
    if emit: run("emit", False)
    run("normal", True)
    fm = bpy.data.materials.new(name); fnt = fm.node_tree; fb = fnt.nodes["Principled BSDF"]; L = fnt.links.new
    def t(chan):
        n = fnt.nodes.new("ShaderNodeTexImage"); n.image = imgs[chan]; return n
    L(t("color").outputs["Color"], fb.inputs["Base Color"])
    L(t("rough").outputs["Color"], fb.inputs["Roughness"])
    if metal: L(t("metal").outputs["Color"], fb.inputs["Metallic"])
    else: fb.inputs["Metallic"].default_value = 0.0
    nm = fnt.nodes.new("ShaderNodeNormalMap"); L(t("normal").outputs["Color"], nm.inputs["Color"]); L(nm.outputs["Normal"], fb.inputs["Normal"])
    if emit:
        L(t("emit").outputs["Color"], fb.inputs["Emission Color"]); fb.inputs["Emission Strength"].default_value = 1.0
    lo.data.materials.clear(); lo.data.materials.append(fm)
    bpy.data.objects.remove(hi)
    print(name, "low faces", len(lo.data.polygons))


# ---------------------------------------------------------------------------------------------------- recipes
def rock_material(name, soot=False, lichen=0.6):
    m = M(name)
    d = m.img("dark_rock_02", "_diff_", 1.4, noncolor=False)
    r = m.img("dark_rock_02", "_rough_", 1.4)
    cav = m.pointy()
    macro = m.noise(2.2, 4)
    base = m.mix(1.0, d.outputs["Color"], (0.52, 0.5, 0.55), "MULTIPLY")
    base = m.mix(m.ramp(macro.outputs["Fac"], 0.35, 0.7, 0.0, 0.5), base, (0.03, 0.035, 0.04))     # mottling
    base = m.mix(m.ramp(cav, 0.0, 1.0, 0.65, 0.0), base, (0.01, 0.012, 0.014))                     # dark cavities
    base = m.mix(m.ramp(cav, 0.6, 1.0, 0.0, 0.35), base, (0.32, 0.33, 0.34))                       # worn edges catch light
    # Alien lichen: teal crust in the cracks that glows faintly.
    lv = m.voronoi(26.0, "DISTANCE_TO_EDGE")
    ln = m.noise(5.0, 3)
    lmask = m.math("MULTIPLY", m.ramp(lv.outputs["Distance"], 0.0, 0.05, 1.0, 0.0), m.ramp(ln.outputs["Fac"], 0.5, 0.62))
    lmask = m.math("MULTIPLY", lmask, m.ramp(cav, 0.0, 0.6, 1.0, 0.0))
    lmask = m.math("MULTIPLY", lmask, lichen)
    base = m.mix(lmask, base, (0.04, 0.12, 0.1))
    emit = m.mix(lmask, (0, 0, 0), (0.05, 0.42, 0.34))
    if soot:
        # Fire-blackened toward the ring centre and top.
        dist = m.n("ShaderNodeVectorMath", _operation="LENGTH"); m.L(m.tc.outputs["Object"], dist.inputs[0])
        s = m.ramp(dist.outputs["Value"], 0.25, 0.55, 1.0, 0.0)
        base = m.mix(s, base, (0.012, 0.01, 0.009))
    rough = m.ramp(r.outputs["Color"], 0.0, 1.0, 0.78, 1.0)
    h = m.math("ADD", m.voronoi(14.0, "DISTANCE_TO_EDGE").outputs["Distance"], m.math("MULTIPLY", m.noise(40.0, 8).outputs["Fac"], 0.4))
    return m.finish(base, rough, 0.0, emit, h, 0.55, 0.003)


def trunk_material(name, char=False):
    m = M(name)
    # Fibres along the trunk (local Z): stretched noise; dark violet-grey flesh, pale torn ends.
    mp = m.n("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (22, 22, 2.2); m.L(m.tc.outputs["Object"], mp.inputs["Vector"])
    fib = m.n("ShaderNodeTexNoise", Scale=4.0, Detail=10.0, Roughness=0.7); m.L(mp.outputs["Vector"], fib.inputs["Vector"])
    wave = m.n("ShaderNodeTexWave", _wave_type="BANDS", _bands_direction="Z", Scale=2.0, Distortion=9.0, Detail=6.0)
    m.L(m.tc.outputs["Object"], wave.inputs["Vector"])
    cav = m.pointy(0.45, 0.56)
    base = m.mix(m.ramp(fib.outputs["Fac"], 0.35, 0.7), (0.035, 0.028, 0.04), (0.11, 0.085, 0.11))
    base = m.mix(m.ramp(cav, 0.0, 0.8, 0.6, 0.0), base, (0.008, 0.006, 0.01))
    # Pale inner flesh where it was torn (faces pointing along the trunk axis).
    ny = m.n("ShaderNodeSeparateXYZ"); m.L(m.geo.outputs["Normal"], ny.inputs[0])
    endmask = m.ramp(m.math("ABSOLUTE", ny.outputs["Z"]), 0.6, 0.9)
    flesh = m.mix(m.ramp(fib.outputs["Fac"], 0.3, 0.7), (0.32, 0.27, 0.24), (0.5, 0.44, 0.38))
    emit = (0, 0, 0)
    if char:
        # Charred: cracked black, embers glowing in the cracks near the foot.
        cr = m.voronoi(9.0, "DISTANCE_TO_EDGE")
        crack = m.ramp(cr.outputs["Distance"], 0.0, 0.04, 1.0, 0.0)
        base = m.mix(0.96, base, (0.008, 0.007, 0.007))
        zpos = m.n("ShaderNodeSeparateXYZ"); m.L(m.tc.outputs["Object"], zpos.inputs[0])
        foot = m.ramp(zpos.outputs["Z"], 0.25, 0.0)
        e = m.math("MULTIPLY", crack, foot)
        emit = m.mix(e, (0, 0, 0), (1.0, 0.32, 0.06))
        base = m.mix(e, base, (0.3, 0.09, 0.02))
        h = m.math("ADD", m.math("MULTIPLY", cr.outputs["Distance"], 2.0), fib.outputs["Fac"])
    else:
        base = m.mix(endmask, base, flesh)
        # Faint bioluminescent threads running along the fibres.
        # Faint threads running along the length: a narrow band of the stretched fibre noise, broken up.
        th = m.math("MULTIPLY", m.ramp(fib.outputs["Fac"], 0.585, 0.6), m.ramp(fib.outputs["Fac"], 0.63, 0.615))
        th = m.math("MULTIPLY", th, m.ramp(m.noise(2.5, 2).outputs["Fac"], 0.5, 0.62))
        emit = m.mix(th, (0, 0, 0), (0.05, 0.3, 0.25))
        h = m.math("ADD", m.math("MULTIPLY", wave.outputs["Fac"], 0.6), fib.outputs["Fac"])
    rough = m.ramp(fib.outputs["Fac"], 0.3, 0.8, 0.35, 0.8) if not char else m.ramp(fib.outputs["Fac"], 0.3, 0.8, 0.8, 0.98)
    return m.finish(base, rough, 0.0, emit, h, 0.6, 0.002)


def metal_material(name, scorch=0.5):
    m = M(name)
    paint = m.img("metal_plate_02", "_diff_", 0.9, noncolor=False)
    prough = m.img("metal_plate_02", "_rough_", 0.9)
    rust = m.img("rusty_metal_02", "_diff_", 1.3, noncolor=False)
    rrough = m.img("rusty_metal_02", "_rough_", 1.3)
    cav = m.pointy(0.46, 0.56)
    edge = m.ramp(cav, 0.62, 0.95)
    rn = m.noise(3.5, 6, 0.65)
    rustmask = m.math("ADD", m.ramp(rn.outputs["Fac"], 0.48, 0.66), m.ramp(cav, 0.0, 0.5, 0.6, 0.0), clamp=True)
    # Hull paint: dark gunmetal with a faded hazard-orange stencil band.
    painted = m.mix(1.0, paint.outputs["Color"], (0.32, 0.34, 0.37), "MULTIPLY")
    band = m.n("ShaderNodeTexWave", _wave_type="BANDS", Scale=0.3, Distortion=0.0); m.L(m.tc.outputs["Object"], band.inputs["Vector"])
    stripe = m.math("MULTIPLY", m.ramp(band.outputs["Fac"], 0.93, 0.95), m.ramp(m.noise(8, 4).outputs["Fac"], 0.4, 0.55))  # one worn stencil band, not planks
    painted = m.mix(stripe, painted, (0.5, 0.18, 0.04))
    bare = (0.42, 0.42, 0.44)
    base = m.mix(edge, painted, bare)                                                      # chipped to bare metal on edges
    base = m.mix(rustmask, base, m.mix(1.0, rust.outputs["Color"], (0.7, 0.55, 0.45), "MULTIPLY"))
    # Scorch: blackened blooms from the re-entry fire.
    sc = m.ramp(m.noise(1.6, 3).outputs["Fac"], 0.5, 0.68, 0.0, scorch)
    base = m.mix(sc, base, (0.015, 0.013, 0.012))
    metal = m.math("MAXIMUM", m.math("MULTIPLY", edge, 1.0), m.math("MULTIPLY", m.math("SUBTRACT", 1.0, rustmask), 0.25))
    metal = m.math("MULTIPLY", metal, m.math("SUBTRACT", 1.0, sc))
    rough = m.mix(rustmask, prough.outputs["Color"], rrough.outputs["Color"])
    rough = m.math("ADD", m.math("MULTIPLY", rough, 0.7), m.math("MULTIPLY", sc, 0.3))
    # Panel seams and rivet rows in the height (baked into the normal map).
    seams = m.n("ShaderNodeTexBrick", Scale=2.2, _offset=0.5)
    m.L(m.tc.outputs["Object"], seams.inputs["Vector"]); seams.inputs["Mortar Size"].default_value = 0.012
    seams.inputs["Color1"].default_value = (1, 1, 1, 1); seams.inputs["Color2"].default_value = (1, 1, 1, 1); seams.inputs["Mortar"].default_value = (0, 0, 0, 1)
    riv = m.voronoi(38.0)
    rivets = m.ramp(riv.outputs["Distance"], 0.08, 0.05)
    h = m.math("ADD", m.math("MULTIPLY", seams.outputs["Color"], 0.8), m.math("MULTIPLY", rivets, 0.25))
    h = m.math("ADD", h, m.math("MULTIPLY", rn.outputs["Fac"], 0.15))
    return m.finish(base, rough, metal, None, h, 0.5, 0.003)


def glow_flesh_material(name, color, stem=(0.03, 0.035, 0.035), split=0.06, cells=18.0):
    """Bulbs / sprout heads: translucent-looking flesh with bright veins, dark stem and root below `split` (z)."""
    m = M(name)
    z = m.n("ShaderNodeSeparateXYZ"); m.L(m.tc.outputs["Object"], z.inputs[0])
    top = m.ramp(z.outputs["Z"], split - 0.01, split + 0.02)
    v = m.voronoi(cells, "DISTANCE_TO_EDGE")
    vein = m.ramp(v.outputs["Distance"], 0.0, 0.02, 1.0, 0.0)
    halo = m.ramp(v.outputs["Distance"], 0.0, 0.35, 1.0, 0.0)
    # Veins fade in and out along their length: not a uniform net.
    vein = m.math("MULTIPLY", vein, m.ramp(m.noise(6.0, 3).outputs["Fac"], 0.4, 0.65))
    fl = m.noise(12.0, 4)
    flesh = m.mix(m.ramp(fl.outputs["Fac"], 0.3, 0.7), tuple(c * 0.12 for c in color), tuple(c * 0.3 for c in color))
    base = m.mix(top, stem, flesh)
    e = m.math("ADD", m.math("MULTIPLY", vein, 0.6), m.math("MULTIPLY", m.math("MULTIPLY", halo, halo), 0.22))
    e = m.math("MULTIPLY", e, top)
    emit = m.mix(e, (0, 0, 0), color)
    rough = m.lerp(top, 0.7, 0.18)
    h = m.math("ADD", m.math("MULTIPLY", v.outputs["Distance"], 1.2), m.math("MULTIPLY", fl.outputs["Fac"], 0.3))
    return m.finish(base, rough, 0.0, emit, h, 0.35, 0.002)


def fabric_material(name):
    m = M(name)
    # Suit fabric: grey ripstop weave, grime in folds, a reflective hazard stripe across the middle (local x ~ 0).
    weave = m.n("ShaderNodeTexWave", _wave_type="BANDS", _bands_direction="X", Scale=90.0, Distortion=0.4)
    weave2 = m.n("ShaderNodeTexWave", _wave_type="BANDS", _bands_direction="Y", Scale=90.0, Distortion=0.4)
    m.L(m.tc.outputs["Object"], weave.inputs["Vector"]); m.L(m.tc.outputs["Object"], weave2.inputs["Vector"])
    w = m.math("MULTIPLY", weave.outputs["Fac"], weave2.outputs["Fac"])
    cav = m.pointy(0.46, 0.54)
    grime = m.math("ADD", m.ramp(cav, 0.0, 0.6, 0.7, 0.0), m.ramp(m.noise(4, 5).outputs["Fac"], 0.5, 0.7, 0.0, 0.5), clamp=True)
    x = m.n("ShaderNodeSeparateXYZ"); m.L(m.tc.outputs["Object"], x.inputs[0])
    stripe = m.ramp(m.math("ABSOLUTE", x.outputs["X"]), 0.045, 0.035)
    base = m.mix(m.ramp(w, 0.0, 1.0, 0.85, 1.0), (0.2, 0.21, 0.22), (0.26, 0.27, 0.28))
    base = m.mix(stripe, base, (0.6, 0.22, 0.05))
    base = m.mix(grime, base, (0.03, 0.025, 0.02))
    emit = m.mix(m.math("MULTIPLY", stripe, 0.25), (0, 0, 0), (0.85, 0.36, 0.1))
    rough = m.lerp(stripe, 0.85, 0.4)
    h = m.math("ADD", m.math("MULTIPLY", w, 0.4), m.math("MULTIPLY", m.noise(14, 6).outputs["Fac"], 0.6))
    return m.finish(base, rough, 0.0, emit, h, 0.3, 0.002)


# ---------------------------------------------------------------------------------------------------- props
def make(name, bm, voxel=None, smooth=2, disp=(), faces=1500, mat=None, size=BASE, ext=0.01, metal=False, emit=True):
    hi = bm_obj(name + "_High", bm)
    if voxel: remesh(hi, voxel, smooth, disp)
    elif disp: displace(hi, disp)
    lo = low_from(hi, name, faces)
    unwrap(lo)
    bake(name, lo, hi, mat, size, ext, metal, emit)
    return lo


# Stone (gatherable): fractured rock with a lichen crust.
make("Stone", rock_bm(0.22, 3.1, 0.7, 4, 5), 0.004, 1, [("VORONOI", 0.05, 0.004), ("CLOUDS", 0.12, 0.006)], 320, rock_material("Stone"), BASE, 0.012)

# Stalkwood: a broken length of fungal trunk.
make("Stalkwood", trunk_bm(1.2, 0.08, 0.06, 1.0), 0.005, 1, [("CLOUDS", 0.05, 0.004)], 420, trunk_material("Stalkwood"), BASE, 0.012)

# Fiber: a tuft of curved blades with pale glowing tips (vertex colour, no bake: too thin to bake usefully).
ORGANIC = bpy.data.materials.new("Organic"); _b = ORGANIC.node_tree.nodes["Principled BSDF"]
_b.inputs["Roughness"].default_value = 0.5
_vc = ORGANIC.node_tree.nodes.new("ShaderNodeVertexColor"); _vc.layer_name = "Col"; ORGANIC.node_tree.links.new(_vc.outputs["Color"], _b.inputs["Base Color"])
bm = bmesh.new()
for b in range(17):
    a = b / 17 * math.tau + random.uniform(-0.25, 0.25); h = random.uniform(0.42, 0.85); lean = random.uniform(0.18, 0.6)
    w = random.uniform(0.014, 0.024); twist = random.uniform(-0.8, 0.8); prevL = prevR = None
    for k in range(9):
        t = k / 8
        c = Vector((math.cos(a) * lean * t * t * h, math.sin(a) * lean * t * t * h, t * h))
        ang = a + twist * t
        side = Vector((-math.sin(ang), math.cos(ang), 0)) * w * (1 - t * 0.9)
        fold = Vector((math.cos(ang), math.sin(ang), 0)) * w * 0.35 * (1 - t)  # a shallow V crease along the blade
        L = bm.verts.new(c - side + fold); C = bm.verts.new(c); R = bm.verts.new(c + side + fold)
        if prevL: bm.faces.new((prevL[0], prevL[1], C, L)); bm.faces.new((prevL[1], prevL[2], R, C))
        prevL = (L, C, R)
def fiber_col(co):
    t = min(1.0, co.z / 0.75)
    return (0.05 + 0.35 * t ** 4, 0.09 + 0.78 * t ** 4, 0.08 + 0.62 * t ** 4, 1.0)  # tips bright enough to glow
fo = bm_obj("Fiber", bm, ORGANIC, fiber_col)

# Sprout: a curled stem with a glowing bud.
bm = trunk_bm(0.32, 0.02, 0.011, 4.0, rings=24, segs=12, ridges=5, torn=0.0)
bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, 0.16))
for v in bm.verts: v.co.x += (v.co.z ** 2) * 0.5
m_ = bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=16, radius=0.045)
bmesh.ops.scale(bm, vec=(1, 1, 1.3), verts=m_["verts"]); bmesh.ops.translate(bm, verts=m_["verts"], vec=(0.05, 0, 0.345))
make("Sprout", bm, 0.0025, 1, [("CLOUDS", 0.02, 0.002)], 110, glow_flesh_material("Sprout", (0.35, 1.0, 0.85), split=0.3, cells=30.0), BASE // 2, 0.006)

# Bulbs: a cluster of glowing bulbs on a root knot.
bm = rock_bm(0.12, 9.0, 0.5, 3, 0)
for i in range(9):
    a = random.uniform(0, math.tau); r = random.uniform(0.02, 0.16); s = random.uniform(0.04, 0.11)
    mm = bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=14, radius=s)
    bmesh.ops.scale(bm, vec=(1, 1, random.uniform(1.1, 1.9)), verts=mm["verts"])
    bmesh.ops.translate(bm, verts=mm["verts"], vec=(math.cos(a) * r, math.sin(a) * r, s * 1.3 + 0.03))
make("Bulbs", bm, 0.004, 1, [("CLOUDS", 0.04, 0.003)], 450, glow_flesh_material("Bulbs", (0.45, 0.85, 1.0), split=0.06, cells=16.0), BASE, 0.01)


# Debris: bent, torn, dented hull plates with bevelled edges.
def plate_bm(sx, sy, bend, seed, segs=(40, 24)):
    bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=segs[0], y_segments=segs[1], size=0.5)
    for v in bm.verts:
        v.co.x *= sx; v.co.y *= sy
        v.co.z += math.sin(v.co.x / sx * 2.5) * bend + noise.noise(v.co * 2 + Vector((seed, 0, 0))) * 0.04
        v.co.z -= max(0.0, noise.noise(v.co * 4 + Vector((0, seed, 0))) - 0.35) * 0.08  # impact dents
    cut = [v for v in bm.verts if v.co.x + v.co.y * 0.8 > (sx + sy) * 0.33 + noise.noise(v.co * 6) * 0.08]
    bmesh.ops.delete(bm, geom=cut, context="VERTS")
    # ragged torn edge: jitter boundary verts in-plane
    for v in bm.verts:
        if v.is_boundary: v.co.x += noise.noise(v.co * 25) * 0.02; v.co.y += noise.noise(v.co * 25 + Vector((5, 0, 0))) * 0.02
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.025)
    return bm


def make_plate(name, sx, sy, bend, seed, mat):
    hi = bm_obj(name + "_High", plate_bm(sx, sy, bend, seed))
    bv = hi.modifiers.new("bv", "BEVEL"); bv.width = 0.006; bv.segments = 2; bv.limit_method = "ANGLE"
    apply_all(hi)
    for p in hi.data.polygons: p.use_smooth = True
    lo = bm_obj(name, plate_bm(sx, sy, bend, seed, (14, 8)))
    unwrap(lo)
    bake(name, lo, hi, mat, BASE, 0.03, metal=True, emit=False)
    return lo


HULL = metal_material("Hull", 0.55)
make_plate("Debris_1", 1.6, 0.9, 0.12, 1.0, HULL)
make_plate("Debris_2", 1.0, 0.7, 0.2, 2.0, metal_material("Hull2", 0.7))
make_plate("Debris_3", 2.2, 0.6, 0.06, 3.0, metal_material("Hull3", 0.4))

# Campfire: a ring of soot-blackened fractured stones, a scorched scrap windbreak, charred fungal wood.
bm = bmesh.new()
for i in range(8):
    a = i / 8 * math.tau; s = random.uniform(0.13, 0.19)
    rb = rock_bm(s, i * 1.7 + 0.3, 0.65, 3, 4)
    bmesh.ops.translate(rb, verts=rb.verts, vec=(math.cos(a) * 0.48, math.sin(a) * 0.48, s * 0.35))
    merge_into(bm, rb)
make("Campfire_Stones", bm, 0.005, 1, [("VORONOI", 0.05, 0.004)], 1300, rock_material("Campfire_Stones", soot=True, lichen=0.2), BASE, 0.012)

bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=32, y_segments=16, size=0.5)
for v in bm.verts:
    a = v.co.x * 1.6
    r = 0.72; x, y = math.sin(a) * r, -math.cos(a) * r
    v.co = Vector((x, y, (v.co.y + 0.5) * 0.55 + noise.noise(Vector((x * 4, y * 4, 1))) * 0.04))
cut = [v for v in bm.verts if v.co.z > 0.42 + noise.noise(v.co * 7) * 0.12]
bmesh.ops.delete(bm, geom=cut, context="VERTS")
bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.02)
hi = bm_obj("Campfire_Scrap_High", bm)
bv = hi.modifiers.new("bv", "BEVEL"); bv.width = 0.005; bv.segments = 2; bv.limit_method = "ANGLE"; apply_all(hi)
lo = low_from(hi, "Campfire_Scrap", 700); unwrap(lo)
bake("Campfire_Scrap", lo, hi, metal_material("Scrap", 0.85), BASE, 0.02, metal=True, emit=False)

bm = bmesh.new()
for i in range(4):
    p = trunk_bm(0.8, 0.065, 0.045, 10 + i, rings=36, segs=24, ridges=9)
    a = i / 4 * math.tau + 0.4
    bmesh.ops.transform(p, matrix=Matrix.Rotation(a, 4, "Z") @ Matrix.Rotation(math.radians(58), 4, "Y"), verts=p.verts)
    bmesh.ops.translate(p, verts=p.verts, vec=(math.cos(a) * 0.14, math.sin(a) * 0.14, 0.24))
    merge_into(bm, p)
make("Campfire_Wood", bm, 0.005, 1, [("VORONOI", 0.04, 0.004)], 1100, trunk_material("Campfire_Wood", char=True), BASE, 0.012)

# Pack: a padded suit-fabric bag with seams, a flap and a strap.
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=10, use_grid_fill=True)
for v in bm.verts:
    v.co = v.co.normalized() * 0.5 * 0.6 + v.co * 0.4
    v.co.x *= 0.56; v.co.y *= 0.42; v.co.z *= 0.36
    v.co += Vector((0, 0, 0.18)) + Vector((noise.noise(v.co * 6), noise.noise(v.co * 6 + Vector((3, 0, 0))), noise.noise(v.co * 5) * 0.5)) * 0.018
m_ = bmesh.ops.create_cone(bm, cap_ends=False, segments=24, radius1=0.2, radius2=0.2, depth=0.045)
for v in m_["verts"]: v.co = Matrix.Rotation(math.radians(90), 4, "Y") @ v.co
bmesh.ops.translate(bm, verts=m_["verts"], vec=(0, 0, 0.28))
make("Pack", bm, 0.005, 2, [("CLOUDS", 0.06, 0.006), ("CLOUDS", 0.015, 0.0015)], 1400, fabric_material("Pack"), BASE, 0.012)

# ---------------------------------------------------------------------------------------------------- export
for o in bpy.context.view_layer.objects: o.select_set(True)
glb = os.path.join(OUT, "props.glb")
kw = dict(filepath=glb, export_format="GLB", use_selection=True, export_apply=True, export_yup=True)
try: bpy.ops.export_scene.gltf(**kw, export_image_format="WEBP", export_image_quality=86)
except TypeError: bpy.ops.export_scene.gltf(**kw)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "bc_props.blend"))
print("@@DONE@@", glb, os.path.getsize(glb), [(o.name, len(o.data.polygons)) for o in bpy.data.objects])
