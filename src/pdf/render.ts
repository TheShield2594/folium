import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const docs = new Map<string, Promise<pdfjs.PDFDocumentProxy>>();

/** Load (and cache) a PDF for display. `key` identifies the bytes, e.g. a template id. */
export function loadPdf(key: string, bytes: () => Promise<Uint8Array>): Promise<pdfjs.PDFDocumentProxy> {
  if (!docs.has(key)) {
    // pdf.js takes ownership of the buffer it's given, so hand it a copy.
    const p = bytes().then((b) => pdfjs.getDocument({ data: b.slice(), isEvalSupported: false }).promise);
    // Don't cache a failure; only drop the entry if it's still this attempt.
    p.catch(() => {
      if (docs.get(key) === p) docs.delete(key);
    });
    docs.set(key, p);
  }
  return docs.get(key)!;
}

export function forgetPdf(key: string) {
  docs.get(key)?.then((d) => d.destroy()).catch(() => undefined);
  docs.delete(key);
}

const active = new WeakMap<HTMLCanvasElement, pdfjs.RenderTask>();

/**
 * Render one page into a canvas. A canvas only ever has one render in flight: starting
 * a new one cancels the old, since overlapping renders corrupt the canvas transform.
 */
export async function renderPage(doc: pdfjs.PDFDocumentProxy, pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number) {
  const page = await doc.getPage(pageNumber);
  // No awaits between cancelling the old task and registering the new one.
  active.get(canvas)?.cancel();
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: scale * dpr });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${(base.height * scale).toFixed(1)}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const task = page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjs.AnnotationMode.DISABLE });
  active.set(canvas, task);
  try {
    await task.promise;
  } finally {
    if (active.get(canvas) === task) active.delete(canvas);
  }
  return { width: base.width, height: base.height, scale };
}
