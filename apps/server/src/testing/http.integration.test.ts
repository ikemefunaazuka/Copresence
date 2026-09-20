import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TestServer } from './harness.js';
import { startTestServer } from './harness.js';

/** Real HTTP requests against the real, fully composed server — no supertest needed for this surface. */
describe('HTTP integration', () => {
  let testServer: TestServer;

  beforeEach(async () => {
    testServer = await startTestServer();
  });

  afterEach(async () => {
    await testServer.close();
  });

  function url(path: string): string {
    return `http://127.0.0.1:${testServer.port}${path}`;
  }

  it('GET /healthz reports liveness', async () => {
    const res = await fetch(url('/healthz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz reports readiness', async () => {
    const res = await fetch(url('/readyz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });
  });

  it('POST /api/sessions creates a session and returns its DTO', async () => {
    const res = await fetch(url('/api/sessions'), { method: 'POST' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sid: string; participantCount: number };
    expect(typeof body.sid).toBe('string');
    expect(body.participantCount).toBe(0);
  });

  it('GET /api/sessions/:sid finds a session created moments before', async () => {
    const created = (await (await fetch(url('/api/sessions'), { method: 'POST' })).json()) as {
      sid: string;
    };
    const res = await fetch(url(`/api/sessions/${created.sid}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sid: string };
    expect(body.sid).toBe(created.sid);
  });

  it('GET /api/sessions/:sid returns 404 for an unknown, well-formed id', async () => {
    const res = await fetch(url('/api/sessions/never-created'));
    expect(res.status).toBe(404);
  });

  it('repeatedly hitting POST /api/sessions past the rate limit gets throttled with 429', async () => {
    const attempts = Array.from({ length: 130 }, () =>
      fetch(url('/api/sessions'), { method: 'POST' }),
    );
    const results = await Promise.all(attempts);
    expect(results.some((r) => r.status === 429)).toBe(true);
  });
});
