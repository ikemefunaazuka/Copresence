/**
 * Reads the document/viewport metadata that goes out on `hello` and on
 * resize — the receiving side needs `docWidth`/`docHeight`/`dpr` to make
 * sense of a document-normalised cursor position at all (docs/adr/0005).
 * The only function in `capture/` that touches `document`/`window`
 * directly rather than being handed values — deliberately isolated here
 * so everything downstream of it stays testable without a real DOM.
 */
export interface ViewportMetadata {
  readonly docWidth: number;
  readonly docHeight: number;
  readonly dpr: number;
}

export function readViewportMetadata(doc: Document = document, win: Window = window): ViewportMetadata {
  const root = doc.documentElement;
  return {
    docWidth: root.scrollWidth,
    docHeight: root.scrollHeight,
    dpr: win.devicePixelRatio || 1,
  };
}

export function readScrollOffset(win: Window = window): { readonly x: number; readonly y: number } {
  return { x: win.scrollX, y: win.scrollY };
}
