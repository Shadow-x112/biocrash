"""Converts a .glb to a single self-contained glTF JSON (buffer as a base64 data URI), saved with a .json extension
so static hosts that only serve common types (the claude.ai artifact) will serve it. GLTFLoader reads it unchanged."""
import json, struct, base64, sys
src, dst = sys.argv[1], sys.argv[2]
b = open(src, 'rb').read()
assert b[:4] == b'glTF'
off = 12; js = None; binc = b''
while off < len(b):
    ln, typ = struct.unpack_from('<II', b, off); chunk = b[off + 8: off + 8 + ln]
    if typ == 0x4E4F534A: js = json.loads(chunk)
    elif typ == 0x004E4942: binc = chunk
    off += 8 + ln
js['buffers'][0]['uri'] = 'data:application/octet-stream;base64,' + base64.b64encode(binc).decode()
open(dst, 'w').write(json.dumps(js, separators=(',', ':')))
print(dst, len(open(dst).read()) / 1e6, 'MB', [m.get('name') for m in js.get('meshes', [])], [n.get('name') for n in js['nodes']])
