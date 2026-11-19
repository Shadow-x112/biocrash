import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  base: './', // relative paths so the build runs from any folder or host
  plugins: [wasm()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['@dimforge/rapier3d'] },
  server: { open: true },
});
