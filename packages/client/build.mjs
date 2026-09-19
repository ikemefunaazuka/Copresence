import { build } from 'esbuild';

// Bundles the injectable SDK to a single IIFE under window.__copresence.
// The 10KB gzipped budget is enforced separately by `npm run size`
// (size-limit, configured in .size-limit.json) — see ADR 0010.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: '__copresence',
  target: ['es2020'],
  outfile: 'dist/copresence.js',
  sourcemap: true,
  legalComments: 'none',
});
