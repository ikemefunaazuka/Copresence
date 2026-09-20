// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { createShadowHost } from './shadowRoot.js';

describe('createShadowHost', () => {
  it('appends a host element to the document body', () => {
    const before = document.body.children.length;
    const { host } = createShadowHost(document);
    expect(document.body.children.length).toBe(before + 1);
    expect(document.body.contains(host)).toBe(true);
    host.remove();
  });

  it('attaches a closed shadow root — host.shadowRoot is null from the outside', () => {
    const { host, root } = createShadowHost(document);
    expect(root).toBeInstanceOf(ShadowRoot);
    expect(host.shadowRoot).toBeNull(); // exactly what "closed" mode guarantees
    host.remove();
  });

  it('the host does not intercept pointer events, so it cannot break the underlying page', () => {
    const { host } = createShadowHost(document);
    expect(host.style.pointerEvents).toBe('none');
    host.remove();
  });

  it('destroy() removes the host from the document', () => {
    const { host, destroy } = createShadowHost(document);
    expect(document.body.contains(host)).toBe(true);
    destroy();
    expect(document.body.contains(host)).toBe(false);
  });

  it('is resistant to a host page style resetting every element’s position — inline styles win regardless', () => {
    const style = document.createElement('style');
    style.textContent = '* { position: relative !important; }';
    document.head.appendChild(style);

    const { host } = createShadowHost(document);
    expect(host.style.position).toBe('fixed');
    // jsdom does not compute a real cascade, so the assertion above would
    // pass even without `!important` on the inline declaration. The
    // property that actually matters — and the one that would let a
    // `* { position: relative !important }` host rule win in a real
    // browser if it regressed — is the priority: an author stylesheet
    // rule with `!important` beats a *plain* inline style, and only loses
    // to an inline declaration that is itself `!important`.
    expect(host.style.getPropertyPriority('position')).toBe('important');

    host.remove();
    style.remove();
  });
});
