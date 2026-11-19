# Biocrash

First-person stylized survival web game (Three.js + TypeScript + Vite + Rapier).
Design doc: "Biocrash — Game Design Draft" (Claude Docs).

## Run

```
npm install
npm run dev      # opens http://localhost:5173
npm run build    # production files in dist/
```

## M0 tech test (current)

- Smooth terrain from a seeded 3D density field, meshed with surface nets in Web Workers (`src/terrain`).
- 32 m chunks, view radius 4 chunks, physics colliders only on the nearest chunks.
- Left click digs, right click fills (hold to repeat).
- Saves = seed + edited chunks only, in IndexedDB; autosave every 10 s, F5 to save now, export/import a save file.
- HUD shows FPS, frame time, chunk counts, mesh time and save time.

Controls: WASD, Space jump, Shift run, mouse look, Esc pause.
