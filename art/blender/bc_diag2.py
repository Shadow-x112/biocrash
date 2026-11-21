import bpy, os
out = r"C:\Users\manri\OneDrive\AssetLibrary\3D\Creatures\bc_creatures"
for o in bpy.data.objects: o.select_set(True)
for mode in ("ACTIONS", "NLA_TRACKS", "BROADCAST"):
    p = os.path.join(out, f"test_{mode}.glb")
    try:
        bpy.ops.export_scene.gltf(filepath=p, export_format="GLB", use_selection=True, export_animations=True, export_animation_mode=mode, export_skins=True)
        print("MODE", mode, os.path.getsize(p))
    except Exception as e: print("MODE", mode, "ERR", e)
for a in bpy.data.actions:
    print("SLOT", a.name, [(s.identifier, s.target_id_type) for s in a.slots])
