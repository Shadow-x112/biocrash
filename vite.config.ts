import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  base: './', // relative paths so the build runs from any folder or host
  plugins: [wasm()],
  worker: { format: 'es' },
  // Fonts are inlined into the CSS (small latin subsets): the playtest host only serves a fixed set of file types.
  build: { target: 'es2022', assetsInlineLimit: (file: string) => (file.endsWith('.woff2') ? true : undefined) },
  optimizeDeps: { exclude: ['@dimforge/rapier3d'] },
  server: { open: true },
});
