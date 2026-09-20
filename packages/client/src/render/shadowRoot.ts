/**
 * Closed Shadow DOM for everything this SDK injects — the host page's
 * CSS must never reach in here (a fixture page with
 * `* { position: relative !important }` must not break the cursor
 * layer), and nothing injected here should leak out either. `mode:
 * 'closed'` additionally keeps `host.shadowRoot` from returning anything
 * to host-page script that goes looking for it.
 */
export interface ShadowHost {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  readonly destroy: () => void;
}

export function createShadowHost(doc: Document = document): ShadowHost {
  const host = doc.createElement('div');
  host.setAttribute('data-copresence-root', '');
  // Fixed, full-viewport, click-through, above everything: an overlay
  // that intercepted pointer events would break the page it is injected
  // into, which is exactly the failure mode this whole design exists to
  // avoid. Every declaration carries `!important`: a plain inline style
  // loses to an author stylesheet rule that itself uses `!important`
  // (e.g. `* { position: relative !important }`), since that rule and
  // this inline declaration are compared by specificity only once
  // they're in the same importance tier. An inline `!important`
  // declaration is what actually wins there.
  host.style.cssText =
    'all:initial !important;position:fixed !important;inset:0 !important;pointer-events:none !important;z-index:2147483647 !important;';
  doc.body.appendChild(host);
  const root = host.attachShadow({ mode: 'closed' });

  return {
    host,
    root,
    destroy: () => host.remove(),
  };
}
