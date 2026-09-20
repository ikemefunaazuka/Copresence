import { describe, expect, it } from 'vitest';

import { renderChaosPanel } from './chaosPanel.js';

describe('renderChaosPanel', () => {
  it('is a full HTML document with a control for every chaos knob', () => {
    const html = renderChaosPanel();
    expect(html).toContain('<!doctype html>');
    for (const knob of ['dropRate', 'duplicateRate', 'latencyMs', 'jitterMs', 'reorderWindow']) {
      expect(html).toContain(`id="${knob}"`);
    }
  });

  it('links to the JSON and Prometheus metrics endpoints', () => {
    const html = renderChaosPanel();
    expect(html).toContain('/api/metrics');
    expect(html).toContain('/metrics');
  });

  it('includes partition trigger controls', () => {
    const html = renderChaosPanel();
    expect(html).toContain('/api/chaos/partition');
  });
});
