// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCursorLayer } from './cursorLayer.js';

describe('createCursorLayer', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('creates an element for a new participant on first upsert', () => {
    const layer = createCursorLayer(container, document);
    expect(layer.has('p1')).toBe(false);

    layer.upsert('p1', 10, 20, '#ff0000');

    expect(layer.has('p1')).toBe(true);
    expect(container.children.length).toBe(1);
  });

  it('reuses the same element on a repeat upsert rather than creating a new one', () => {
    const layer = createCursorLayer(container, document);
    layer.upsert('p1', 10, 20, '#ff0000');
    layer.upsert('p1', 30, 40, '#ff0000');

    expect(container.children.length).toBe(1);
  });

  it('moves the element via a CSS transform matching the given coordinates', () => {
    const layer = createCursorLayer(container, document);
    layer.upsert('p1', 15, 25, '#00ff00');

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.transform).toBe('translate(15px, 25px)');
  });

  it('sets the label text when given', () => {
    const layer = createCursorLayer(container, document);
    layer.upsert('p1', 0, 0, '#0000ff', 'Alice');

    const label = container.querySelector('div > div:last-child');
    expect(label?.textContent).toBe('Alice');
  });

  it('setOpacity updates the opacity of an existing element', () => {
    const layer = createCursorLayer(container, document);
    layer.upsert('p1', 0, 0, '#000');
    layer.setOpacity('p1', 0.4);

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.opacity).toBe('0.4');
  });

  it('setOpacity for an unknown participant is a total no-op', () => {
    const layer = createCursorLayer(container, document);
    expect(() => layer.setOpacity('ghost', 0.5)).not.toThrow();
  });

  it('remove() deletes the element and forgets the participant', () => {
    const layer = createCursorLayer(container, document);
    layer.upsert('p1', 0, 0, '#000');
    layer.remove('p1');

    expect(layer.has('p1')).toBe(false);
    expect(container.children.length).toBe(0);
  });

  it('remove() for an unknown participant is a total no-op', () => {
    const layer = createCursorLayer(container, document);
    expect(() => layer.remove('ghost')).not.toThrow();
  });

  it('tracks multiple participants independently', () => {
    const layer = createCursorLayer(container, document);
    layer.upsert('a', 0, 0, '#f00');
    layer.upsert('b', 100, 100, '#0f0');

    expect(container.children.length).toBe(2);
    layer.remove('a');
    expect(container.children.length).toBe(1);
    expect(layer.has('b')).toBe(true);
  });
});
