# Generates sound-effect candidates with the local audio-studio MCP server (Stable Audio 3) and cleans them up.
# Usage: C:\AI\audio-studio\.venv\Scripts\python.exe scripts\sfx-gen.py jobs.json out_dir
# jobs.json: [{"name": "step_soil", "variations": 4, "seconds": 1.2, "source": "...", "action": "...",
#              "material": "...", "space": "...", "prompt": "", "mono": true, "loop": false}]
# Every take is trimmed, peak-normalized to -1 dBFS and copied to out_dir with its .json sidecar
# (prompt, seed, model) so its provenance is kept.
import asyncio, json, shutil, sys
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SERVER = r"C:\AI\audio-studio\.venv\Scripts\audio-studio-mcp.exe"


async def call(s, tool, args):
    r = await s.call_tool(tool, args)
    if getattr(r, 'is_error', None) or getattr(r, 'isError', False):
        raise RuntimeError(f"{tool}: {r.content[0].text if r.content else r}")
    sc = getattr(r, 'structured_content', None) or getattr(r, 'structuredContent', None)
    if sc:
        return sc.get("result", sc)
    return json.loads(r.content[0].text)


async def main(jobs_path, out_dir):
    jobs = json.loads(Path(jobs_path).read_text(encoding="utf-8"))
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    made = []
    async with stdio_client(StdioServerParameters(command=SERVER, args=[])) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            for j in jobs:
                g = await call(s, "generate_audio", {
                    "prompt": j.get("prompt", ""), "audio_type": "sfx", "duration_seconds": j.get("seconds", 2),
                    "variations": j.get("variations", 4), "sound_source": j.get("source", ""),
                    "sound_action": j.get("action", ""), "sound_material": j.get("material", ""),
                    "sound_space": j.get("space", ""), "title": j["name"], "original_idea": j.get("idea", ""),
                    "cfg": j.get("cfg", 1.0), "steps": j.get("steps", 8), "negative_prompt": j.get("negative")})
                for i, c in enumerate(g["candidates"], 1):
                    if j.get("raw"):  # keep the model's output untouched (peak ceiling only)
                        dst = out / f"{j['name']}_{i}.wav"; shutil.copy(c["path"], dst); made.append(str(dst))
                        side = Path(c["path"]).with_suffix(".json")
                        if side.exists(): shutil.copy(side, out / f"{j['name']}_{i}.json")
                        continue
                    p = await call(s, "process_audio", {
                        "input_audio": c["path"], "trim_silence": not j.get("loop", False), "mono": j.get("mono", True),
                        "normalize": "peak", "peak_ceiling_db": -1.0, "loop": j.get("loop", False),
                        "loop_crossfade_ms": j.get("loop_ms", 800), "fade_out_ms": j.get("fade_out_ms", 30),
                        "format": "wav", "sample_rate": 48000, "title": f"{j['name']}_{i}"})
                    dst = out / f"{j['name']}_{i}.wav"
                    shutil.copy(p["path"], dst)
                    side = Path(c["path"]).with_suffix(".json")
                    if side.exists():
                        shutil.copy(side, out / f"{j['name']}_{i}.json")
                    made.append(str(dst))
                print(f"{j['name']}: {len(g['candidates'])} takes in {g.get('wall_seconds', '?')} s", flush=True)
    print(json.dumps(made))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
