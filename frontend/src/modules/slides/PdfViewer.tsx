import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

// pdf.js is loaded on demand: it is large, and the worker must be a real file in the build.
// Vite turns the `?url` import into a hashed asset (a .mjs file), which the production nginx
// serves with a JavaScript MIME type (see nginx.conf).
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return pdfjsPromise;
}

type Props = {
  url: string;
  /** 1-based page to show. */
  page: number;
  onPageCount?: (count: number) => void;
};

/** Draws one page of a PDF, scaled to the width of its container. */
export function PdfViewer({ url, page, onPageCount }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const countRef = useRef(onPageCount);
  countRef.current = onPageCount;

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setError(null);
    loadPdfjs()
      .then((pdfjs) => pdfjs.getDocument({ url, withCredentials: true }).promise)
      .then((d) => {
        if (cancelled) {
          void d.destroy();
          return;
        }
        loaded = d;
        setDoc(d);
        countRef.current?.(d.numPages);
      })
      .catch(() => {
        if (!cancelled) setError("No se pudo abrir la presentación.");
      });
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [url]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(box.clientWidth));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!doc || !canvas || width <= 0) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    doc
      .getPage(Math.max(1, Math.min(page, doc.numPages)))
      .then((p) => {
        if (cancelled) return;
        const base = p.getViewport({ scale: 1 });
        const scale = width / base.width;
        const ratio = window.devicePixelRatio || 1;
        const viewport = p.getViewport({ scale: scale * ratio });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
        canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
        const render = p.render({ canvasContext: canvas.getContext("2d")!, viewport });
        task = render;
        return render.promise;
      })
      .catch(() => {
        // A cancelled render rejects; nothing to show.
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, width]);

  return (
    <div ref={boxRef} className="slides-viewer">
      {error ? <p role="alert">{error}</p> : <canvas ref={canvasRef} aria-label="Diapositiva" />}
    </div>
  );
}
