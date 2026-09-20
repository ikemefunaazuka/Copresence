/**
 * Sends an already-built, JSON-encoded audit message to `POST
 * /audit/beacon`. Two send modes, not one, because they serve genuinely
 * different moments:
 *
 * - `sendBestEffort` — `navigator.sendBeacon`, the only API guaranteed to
 *   survive the page going away (a `pagehide` teardown). It returns
 *   synchronously and tells you only whether the browser *queued* the
 *   request, not whether the server received it — the ~64 KB keepalive
 *   budget is shared across every in-flight request, not granted per
 *   request, so a `false` here is a real, expected outcome to check for,
 *   not an edge case to ignore.
 * - `sendConfirmable` — `fetch(url, { keepalive: true })`, awaited. Used
 *   everywhere the caller can afford to wait for a real 200 and clear the
 *   outbox entry only once acknowledged (init, reconnect, a foreground
 *   flush) — `sendBeacon`'s fire-and-forget boolean is not that
 *   acknowledgement.
 *
 * `text/plain`, not `application/json`: a `Blob` of type `application/json`
 * is not CORS-safelisted, and a request issued on the unload path cannot
 * rely on a preflight completing in time. The server parses the body with
 * the same `decodeInbound` the WebSocket path already uses — see
 * `POST /audit/beacon` in `AuditController.ts`.
 */
export interface Beacon {
  /** Fire-and-*maybe* — check the return value before treating `payload` as delivered. */
  sendBestEffort(payload: string): boolean;
  /** Resolves `true` only once the server has actually acknowledged `payload`. */
  sendConfirmable(payload: string): Promise<boolean>;
}

export interface BeaconOptions {
  readonly url: string;
  /** Injectable so tests never touch a real network. */
  readonly sendBeaconFn?: (url: string, data: string) => boolean;
  readonly fetchFn?: typeof fetch;
}

export function createBeacon(options: BeaconOptions): Beacon {
  const sendBeaconFn =
    options.sendBeaconFn ?? ((url, data) => navigator.sendBeacon(url, data));
  const fetchFn = options.fetchFn ?? ((...args) => fetch(...args));

  return {
    sendBestEffort(payload) {
      try {
        return sendBeaconFn(options.url, payload);
      } catch {
        // A browser that throws instead of returning false (quota exceeded, disabled API) is exactly the "not delivered" case the outbox already exists to retry.
        return false;
      }
    },

    async sendConfirmable(payload) {
      try {
        const response = await fetchFn(options.url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: payload,
          keepalive: true,
        });
        return response.ok;
      } catch {
        return false; // offline, or the keepalive budget was exceeded — leave it for the outbox to retry
      }
    },
  };
}
