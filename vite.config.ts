import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative paths so the build runs from any folder or host
  worker: { format: 'es' },
  build: { target: 'es2022' },
  server: { open: true },
});
