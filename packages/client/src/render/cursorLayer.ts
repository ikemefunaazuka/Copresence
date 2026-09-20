/**
 * One DOM element per remote participant, created on first sight and
 * reused after that — `upsert` never recreates an element that already
 * exists, so the browser is only ever asked to move/recolour it, not
 * rebuild it every frame.
 */
export interface CursorLayer {
  upsert(pid: string, x: number, y: number, color: string, label?: string): void;
  setOpacity(pid: string, opacity: number): void;
  remove(pid: string): void;
  has(pid: string): boolean;
}

const DOT_SIZE_PX = 12;

export function createCursorLayer(root: ShadowRoot | Element, doc: Document = document): CursorLayer {
  const elements = new Map<string, { readonly wrapper: HTMLElement; readonly label: HTMLElement }>();

  function elementFor(pid: string, color: string): { readonly wrapper: HTMLElement; readonly label: HTMLElement } {
    const existing = elements.get(pid);
    if (existing) return existing;

    const wrapper = doc.createElement('div');
    wrapper.style.cssText = [
      'position:absolute',
      'top:0',
      'left:0',
      'pointer-events:none',
      'will-change:transform,opacity',
      'transition:opacity 150ms linear',
    ].join(';');

    const dot = doc.createElement('div');
    dot.style.cssText = `width:${DOT_SIZE_PX}px;height:${DOT_SIZE_PX}px;border-radius:50%;background:${color};box-shadow:0 0 0 1.5px rgba(255,255,255,0.9);`;

    const label = doc.createElement('div');
    label.style.cssText = `margin-top:4px;padding:2px 6px;border-radius:4px;background:${color};color:#fff;font:600 11px/1.4 system-ui,sans-serif;white-space:nowrap;`;

    wrapper.append(dot, label);
    root.appendChild(wrapper);
    const entry = { wrapper, label };
    elements.set(pid, entry);
    return entry;
  }

  return {
    upsert(pid, x, y, color, label): void {
      const entry = elementFor(pid, color);
      entry.wrapper.style.transform = `translate(${x}px, ${y}px)`;
      if (label !== undefined) entry.label.textContent = label;
    },

    setOpacity(pid, opacity): void {
      elements.get(pid)?.wrapper.style.setProperty('opacity', String(opacity));
    },

    remove(pid): void {
      const entry = elements.get(pid);
      if (!entry) return;
      entry.wrapper.remove();
      elements.delete(pid);
    },

    has(pid): boolean {
      return elements.has(pid);
    },
  };
}
