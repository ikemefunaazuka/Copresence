/**
 * @copresence/client
 *
 * The injectable browser SDK. Phase 0 exists only to prove the bundling and
 * size-budget pipeline — that this package builds to a single IIFE and is
 * gated at 10 KB gzipped in CI before a single byte of real behaviour exists.
 *
 * capture/, transport/ and render/ land in Phase 3. Until then this exports
 * a version marker under the one namespaced global the design allows —
 * esbuild's `globalName` is what turns this module's exports into
 * `window.__copresence`, so no manual global assignment happens here.
 */

export const VERSION = '0.1.0';
