"""Packs Poly Haven ground sets into two textures each for the terrain shader:
<name>_col.webp: RGB = albedo * AO, A = height.   <name>_nrm.webp: RG = normal XY, B = roughness."""
import sys, os
from PIL import Image, ImageChops
src, dst = sys.argv[1], sys.argv[2]
for name in ['mud_forest', 'dark_rock_02', 'burned_ground_01']:
    f = lambda k: next(os.path.join(src, x) for x in os.listdir(src) if x.startswith(name + '_' + k))
    diff = Image.open(f('diff')).convert('RGB')
    try:
        ao = Image.open(f('ao')).convert('L'); diff = ImageChops.multiply(diff, Image.merge('RGB', (ao, ao, ao)))
    except StopIteration: pass
    h = Image.open(f('disp')).convert('L').resize(diff.size)
    r, g, b = diff.split(); Image.merge('RGBA', (r, g, b, h)).save(os.path.join(dst, f'{name}_col.webp'), quality=88, method=6)
    n = Image.open(f('nor_gl')).convert('RGB'); nr, ng, _ = n.split()
    ro = Image.open(f('rough')).convert('L').resize(n.size)
    Image.merge('RGB', (nr, ng, ro)).save(os.path.join(dst, f'{name}_nrm.webp'), quality=90, method=6)
    print(name, 'ok')
