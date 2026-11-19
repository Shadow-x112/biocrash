// Builds the game's sound files from the Ocular Sounds library (licensed: the sounds may only ship inside the game,
// never as standalone files, so public/audio/ is git-ignored and rebuilt from the library with this script).
// Usage: node scripts/build-audio.mjs [libraryRoot]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? process.env.OCULAR_ROOT ?? 'C:\\Users\\manri\\OneDrive\\AssetLibrary\\Audio\\_ThirdParty\\OcularSounds';
const list = JSON.parse(readFileSync(new URL('./audio-manifest.json', import.meta.url), 'utf8'));
const out = join(process.cwd(), 'public', 'audio');
mkdirSync(out, { recursive: true });
const manifest = {};
let failed = 0;
for (const s of list) {
  const src = join(root, ...s.src.split('\\'));
  const dst = join(out, `${s.id}.webm`);
  const loop = s.id.startsWith('bed_') || s.id.startsWith('earth_') || s.id === 'drips';
  const filters = [
    loop ? null : 'silenceremove=start_periods=1:start_threshold=-55dB',
    `loudnorm=I=${loop ? -24 : -18}:TP=-2`,
    'afade=t=in:d=0.03',
    `areverse,afade=t=in:d=${loop ? 0.05 : 0.35},areverse`,
  ].filter(Boolean).join(',');
  try {
    if (!existsSync(src)) throw new Error('missing ' + src);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(s.start), '-i', src, '-t', String(s.dur), '-vn', '-af', filters,
      '-ac', s.mono ? '1' : '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', s.mono ? '48k' : '80k', dst]);
    manifest[s.id] = { file: `audio/${s.id}.webm`, gain: s.gain ?? 1, loop };
    process.stdout.write('.');
  } catch (e) { failed++; console.error(`\n${s.id}: ${e.message}`); }
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`\n${Object.keys(manifest).length} sounds built, ${failed} failed -> ${out}`);
