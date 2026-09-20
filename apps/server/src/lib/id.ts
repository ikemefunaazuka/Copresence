/**
 * A single place that generates ids — framework-free, no imports beyond
 * the global `crypto` (available in both Node 19+ and every modern
 * browser, so nothing here would need to change if it were ever reused
 * client-side).
 */
export function generateId(): string {
  return crypto.randomUUID();
}
