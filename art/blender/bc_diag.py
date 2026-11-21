import bpy
for a in bpy.data.actions:
    n = 0
    try:
        for layer in a.layers:
            for strip in layer.strips:
                for cb in strip.channelbags: n += len(cb.fcurves)
    except Exception as e: print("err", e)
    print("ACT", a.name, "slots", len(a.slots), "fcurves", n, "range", tuple(a.frame_range))
for o in bpy.data.objects:
    if o.animation_data: print("OBJ", o.name, [t.name for t in o.animation_data.nla_tracks], [ (s.name, s.action.name if s.action else None, getattr(s,'action_slot',None)) for t in o.animation_data.nla_tracks for s in t.strips][:2])
