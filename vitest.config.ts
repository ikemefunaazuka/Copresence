import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The default for everything except packages/client, whose tests
    // touch real DOM APIs (Shadow DOM, requestAnimationFrame, WebSocket)
    // and opt into `jsdom` individually via an `@vitest-environment`
    // comment at the top of the file — the stable, version-portable way
    // to do this, rather than the workspace/projects config surface.
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts', 'apps/server/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/dist/**',
        // Composition roots — thin by design, exercised by e2e/integration
        // tests rather than unit tests. See CONTRIBUTING.md.
        '**/src/index.ts',
        // Test infrastructure, not production code — exercised heavily by
        // every integration test that uses it, but not unit-tested itself.
        '**/testing/**',
      ],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
