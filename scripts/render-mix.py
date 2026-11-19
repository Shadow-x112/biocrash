# Renders a 70 s scripted night scene through the real game audio engine (OfflineAudioContext in headless Chrome)
# so the mix can be measured (audio-mcp) and listened to. Needs the dev server on :5173 and playwright.
# Usage: python scripts/render-mix.py out.wav
import asyncio, base64, sys
from playwright.async_api import async_playwright
JS = r"""
async () => {
  const { Audio } = await import('/src/audio.ts');
  const SR = 48000, LEN = 70;
  const off = new OfflineAudioContext(2, SR * LEN, SR);
  const Real = window.AudioContext;
  window.AudioContext = function () { return off; };
  const a = new Audio();
  a.unlock();
  window.AudioContext = Real;
  // wait for samples to decode
  for (let i = 0; i < 200 && a.sampleCount < 79; i++) await new Promise(r => setTimeout(r, 100));
  const cam = { position: { x: 0, y: 1.6, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1, _x: 0, _y: 0, _z: 0, _w: 1 } };
  const at = (x, z) => ({ x, y: 1.6, z });
  const beds = { night: a.loop('bed_night'), night2: a.loop('bed_night2'), dread: a.loop('bed_dread'), dread2: a.loop('bed_dread2') };
  const events = [
    [0.1, () => { beds.night.setLevel(0.8, 0.5); beds.night2.setLevel(0.56, 0.5); }],
    [6, () => a.playAny('growl', 10, { pos: at(30, -40), gain: 1.5, rate: 0.85 })],
    [12, () => a.tukoChirp(at(-4, -5))],
    [14, () => a.footstep(false, false, 'moss')], [14.5, () => a.footstep(false, false, 'moss')], [15, () => a.footstep(false, false, 'gravel')],
    [17, () => a.oomiHoot(at(10, -15), false)],
    [22, () => { beds.dread.setLevel(0.6, 2); beds.dread2.setLevel(0.36, 2); }],
    [26, () => a.play('whisper', { pos: at(0.4, 2.2), gain: 0.3, hrtf: true, offset: 3, dur: 5, fadeIn: 1.2 })],
    [33, () => a.playAny('metal', 3, { pos: at(-60, 20), gain: 1.6, rate: 0.7 })],
    [38, () => a.playAny('voice', 3, { pos: at(25, -30), gain: 0.45, fadeIn: 1.5 })],
    [46, () => { a.duck(-14, 1.5, 4, 2.5); a.play('gasp', { gain: 0.35, bus: 'ui', delay: 1.4 }); }],
    [56, () => { a.duck(-14, 1.5, 0.8, 0.3); a.playAny('riser', 3, { gain: 0.35, bus: 'ui', delay: 0.6 }); }],
    [58.4, () => { a.duck(-10, 0.05, 0.4, 1.5); a.play('sting_shadows', { gain: 0.9, bus: 'ui' }); a.play('subdrop', { gain: 0.4, bus: 'ui' }); }],
  ];
  const tick = 0.25;
  for (let t = tick; t < LEN; t += tick) {
    const tt = Math.round(t * 1000) / 1000;
    off.suspend(tt).then(() => {
      a.updateListener(cam); a.updateLoops();
      for (const [et, fn] of events) if (et > tt - tick && et <= tt) fn();
      off.resume();
    });
  }
  a.updateListener(cam);
  const buf = await off.startRendering();
  // 16-bit WAV
  const n = buf.length, ch = 2, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
  out.setUint16(22, ch, true); out.setUint32(24, SR, true); out.setUint32(28, SR * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let i = 0; i < n; i++) { out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
  let s = ''; const u8 = new Uint8Array(out.buffer);
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return [a.sampleCount, btoa(s)];
}
"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
        pg = await b.new_page()
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:5173/'); await pg.wait_for_timeout(1500)
        n, data = await pg.evaluate(JS)
        open(sys.argv[1],'wb').write(base64.b64decode(data))
        print('samples', n, 'errors', errs[:3])
        await b.close()
asyncio.run(main())
