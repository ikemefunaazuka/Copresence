import { describe, expect, it } from 'vitest';

import { opacityFor, stalenessOf } from './staleness.js';

describe('stalenessOf', () => {
  it('is fresh immediately after an update', () => {
    expect(stalenessOf(1000, 1000)).toBe('fresh');
  });

  it('is fresh just under the stale threshold', () => {
    expect(stalenessOf(0, 1_999, 2_000, 10_000)).toBe('fresh');
  });

  it('is stale at and after the stale threshold, before the remove threshold', () => {
    expect(stalenessOf(0, 2_000, 2_000, 10_000)).toBe('stale');
    expect(stalenessOf(0, 9_999, 2_000, 10_000)).toBe('stale');
  });

  it('is expired at and after the remove threshold', () => {
    expect(stalenessOf(0, 10_000, 2_000, 10_000)).toBe('expired');
    expect(stalenessOf(0, 50_000, 2_000, 10_000)).toBe('expired');
  });

  it('uses the shared protocol constants by default', () => {
    expect(stalenessOf(0, 0)).toBe('fresh');
    expect(stalenessOf(0, 3_000)).toBe('stale');
    expect(stalenessOf(0, 11_000)).toBe('expired');
  });
});

describe('opacityFor', () => {
  it('is full opacity when fresh', () => {
    expect(opacityFor('fresh')).toBe(1);
  });

  it('is faded when stale', () => {
    expect(opacityFor('stale')).toBe(0.4);
  });

  it('is a defined value even for expired (the caller removes the element instead of relying on this)', () => {
    expect(opacityFor('expired')).toBe(1);
  });
});
