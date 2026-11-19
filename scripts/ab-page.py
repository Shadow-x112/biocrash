# Builds a single-file blind A/B listening page (works on a phone) from groups of audio takes.
# Usage: python scripts/ab-page.py "Page title" out.html group_name=dir/glob*.wav [group_name=...]
# Takes should already be loudness-matched. Labels are shuffled per group so the listener picks blind;
# "Copy picks" puts the real file names on the clipboard to paste back to Claude.
import base64, glob, json, random, sys, os

title, out, specs = sys.argv[1], sys.argv[2], sys.argv[3:]
groups = []
for spec in specs:
    name, pattern = spec.split('=', 1)
    files = sorted(glob.glob(pattern))
    random.shuffle(files)
    takes = [{"id": os.path.splitext(os.path.basename(f))[0],
              "src": "data:audio/wav;base64," + base64.b64encode(open(f, 'rb').read()).decode()} for f in files]
    groups.append({"name": name, "takes": takes})

html = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title><style>
:root{color-scheme:dark}body{margin:0;background:#0e1013;color:#e6e8eb;font:15px/1.45 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:20px 16px 60px}h1{font-size:20px;margin:0 0 4px}p.sub{color:#9aa3ad;margin:0 0 18px}
section{background:#171a1f;border:1px solid #262b33;border-radius:12px;padding:14px;margin:0 0 14px}
h2{font-size:16px;margin:0 0 10px;text-transform:capitalize}.row{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid #222730}
.row:first-of-type{border-top:0}.lab{width:28px;font-weight:700;color:#c9a46a}button{font:inherit;border:1px solid #333a44;background:#20252c;color:#e6e8eb;border-radius:8px;padding:9px 12px;cursor:pointer}
button:active{background:#2b323c}.pick{margin-left:auto;padding:9px 14px}.pick.on{background:#c9a46a;color:#14110c;border-color:#c9a46a;font-weight:700}
.none{margin-top:8px;font-size:13px;color:#9aa3ad}.none.on{background:#4a2a2a;color:#f0d0d0;border-color:#6a3a3a}
textarea{width:100%;box-sizing:border-box;background:#0e1013;color:#e6e8eb;border:1px solid #262b33;border-radius:8px;padding:8px;margin-top:8px;font:inherit;font-size:13px}
.bar{position:sticky;bottom:0;background:#0e1013;padding:12px 0;display:flex;gap:8px;align-items:center}#copy{flex:1;background:#c9a46a;color:#14110c;border:0;font-weight:700;padding:13px}
#msg{color:#9aa3ad;font-size:13px}label.vol{display:flex;align-items:center;gap:8px;color:#9aa3ad;font-size:13px;margin:0 0 14px}
</style></head><body><main><h1>__TITLE__</h1>
<p class="sub">Blind test: labels are shuffled and every take is at the same loudness. <b>Play</b> hears it once, <b>Walk</b> hears it as repeated steps with small random variation, like in game. Pick your favorite in each group (or "none are good"). <b>A few words on what's wrong helps a lot</b> (too clicky, too soft, sounds like walking on cereal, etc.), then copy your picks and paste them back to Claude.</p>
<label class="vol">Volume <input id="vol" type="range" min="0" max="1.5" step="0.05" value="1"></label>
<div id="groups"></div><div class="bar"><button id="copy">Copy my picks</button><span id="msg"></span></div></main>
<script>
const DATA=__DATA__;let ctx,master;const bufs={};const picks={};const notes={};
function ac(){
 // Create and resume inside the tap itself (iOS/Safari only allow audio started by a gesture).
 if(!ctx){ctx=new (window.AudioContext||window.webkitAudioContext)();master=ctx.createGain();master.connect(ctx.destination);
  try{if(navigator.audioSession)navigator.audioSession.type='playback'}catch(e){} // play even with the iPhone silent switch on
  const s=ctx.createBufferSource();s.buffer=ctx.createBuffer(1,1,22050);s.connect(ctx.destination);s.start(0);}
 master.gain.value=+document.getElementById('vol').value;if(ctx.state!=='running')ctx.resume();return ctx}
function b64(src){const bin=atob(src.split(',')[1]);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u.buffer}
function decode(c,ab){return new Promise((res,rej)=>{const p=c.decodeAudioData(ab,res,rej);if(p&&p.then)p.then(res,rej)})}
async function buf(t){if(bufs[t.id])return bufs[t.id];const c=ac();return bufs[t.id]=await decode(c,b64(t.src))}
function fire(b,when,rate,gain){const s=ctx.createBufferSource(),g=ctx.createGain();s.buffer=b;s.playbackRate.value=rate;g.gain.value=gain;s.connect(g).connect(master);s.start(when)}
async function play(t){const c=ac();const b=await buf(t);fire(b,c.currentTime+0.02,1,1)}
async function walk(t){const c=ac();const b=await buf(t);let w=c.currentTime+0.05;for(let i=0;i<8;i++){fire(b,w,1+(Math.random()*2-1)*0.04,Math.pow(10,((Math.random()*2-1)*1.5)/20));w+=0.46+(Math.random()*2-1)*0.03}}
const root=document.getElementById('groups');
DATA.forEach(g=>{const s=document.createElement('section');s.innerHTML='<h2>'+g.name+'</h2>';
g.takes.forEach((t,i)=>{const r=document.createElement('div');r.className='row';const L=String.fromCharCode(65+i);
r.innerHTML='<span class="lab">'+L+'</span>';const p=document.createElement('button');p.textContent='Play';p.onclick=()=>play(t);
const w=document.createElement('button');w.textContent='Walk';w.onclick=()=>walk(t);const k=document.createElement('button');k.className='pick';k.textContent='Pick';
k.onclick=()=>{picks[g.name]={label:L,id:t.id};s.querySelectorAll('.pick,.none').forEach(e=>e.classList.remove('on'));k.classList.add('on')};
r.append(p,w,k);s.append(r)});
const n=document.createElement('button');n.className='none';n.textContent='None are good';n.onclick=()=>{picks[g.name]={label:'-',id:'none'};s.querySelectorAll('.pick').forEach(e=>e.classList.remove('on'));n.classList.add('on')};
const ta=document.createElement('textarea');ta.rows=2;ta.placeholder='Optional note (e.g. too clicky, want deeper, B and D both OK)';ta.oninput=()=>notes[g.name]=ta.value;
s.append(n,ta);root.append(s)});
document.getElementById('copy').onclick=async()=>{const lines=DATA.map(g=>g.name+': '+((picks[g.name]||{}).id||'(no pick)')+(notes[g.name]?' | '+notes[g.name]:''));const txt='__TITLE__ picks\\n'+lines.join('\\n');
try{await navigator.clipboard.writeText(txt);document.getElementById('msg').textContent='Copied. Paste it to Claude.'}catch(e){prompt('Copy this and paste it to Claude:',txt)}};
</script></body></html>"""
html = html.replace("__TITLE__", title).replace("__DATA__", json.dumps(groups))
open(out, 'w', encoding='utf-8').write(html)
print(out, round(len(html) / 1024), 'KB')
