import { describe, expect, it, vi } from 'vitest';

import { createBeacon } from './beacon.js';

describe('createBeacon', () => {
  describe('sendBestEffort', () => {
    it('calls sendBeaconFn with the configured url and the given payload', () => {
      const sendBeaconFn = vi.fn(() => true);
      const beacon = createBeacon({ url: '/audit/beacon', sendBeaconFn });

      const result = beacon.sendBestEffort('{"t":"session.end"}');

      expect(sendBeaconFn).toHaveBeenCalledWith('/audit/beacon', '{"t":"session.end"}');
      expect(result).toBe(true);
    });

    it('returns false when the browser reports the payload did not fit the queue', () => {
      const beacon = createBeacon({ url: '/audit/beacon', sendBeaconFn: () => false });

      expect(beacon.sendBestEffort('{}')).toBe(false);
    });

    it('returns false rather than throwing when sendBeaconFn itself throws', () => {
      const beacon = createBeacon({
        url: '/audit/beacon',
        sendBeaconFn: () => {
          throw new Error('sendBeacon is disabled');
        },
      });

      expect(beacon.sendBestEffort('{}')).toBe(false);
    });
  });

  describe('sendConfirmable', () => {
    it('POSTs the payload as text/plain with keepalive set, and resolves true on a 2xx response', async () => {
      const fetchFn = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
      const beacon = createBeacon({ url: '/audit/beacon', fetchFn });

      const result = await beacon.sendConfirmable('{"t":"session.start"}');

      expect(result).toBe(true);
      expect(fetchFn).toHaveBeenCalledWith('/audit/beacon', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{"t":"session.start"}',
        keepalive: true,
      });
    });

    it('resolves false on a non-2xx response', async () => {
      const fetchFn = () => Promise.resolve(new Response(null, { status: 500 }));
      const beacon = createBeacon({ url: '/audit/beacon', fetchFn });

      expect(await beacon.sendConfirmable('{}')).toBe(false);
    });

    it('resolves false rather than rejecting when fetch itself fails (offline)', async () => {
      const fetchFn = () => Promise.reject(new Error('network error'));
      const beacon = createBeacon({ url: '/audit/beacon', fetchFn });

      await expect(beacon.sendConfirmable('{}')).resolves.toBe(false);
    });
  });
});
