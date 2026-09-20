import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * Built output is served by the main Express server at `/inspector/` (see
 * apps/server/src/app.ts) — `base` keeps every built asset path relative
 * to that mount point rather than the site root. The dev-server proxy
 * lets `npm run dev` here talk to a real backend running separately
 * (`npm run dev -w apps/server`) without a CORS dance.
 */
export default defineConfig({
  base: '/inspector/',
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
