import { useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, Loader2 } from 'lucide-react';
// Legacy build: includes polyfills for older Safari/Chrome, the PWA must work on any phone.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Renders a page only once it scrolls near the viewport, so long PDFs stay fast on phones.
function Page({ pdf, number, width }) {
  const canvas = useRef();
  const box = useRef();
  const [ratio, setRatio] = useState(1.414);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    pdf.getPage(number).then((p) => {
      const v = p.getViewport({ scale: 1 });
      setRatio(v.height / v.width);
    });
  }, [pdf, number]);

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: '800px' });
    io.observe(box.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !width) return;
    let task;
    pdf.getPage(number).then((page) => {
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * dpr });
      const c = canvas.current;
      c.width = viewport.width;
      c.height = viewport.height;
      task = page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport });
      task.promise.catch(() => {});
    });
    return () => task?.cancel();
  }, [pdf, number, width, visible]);

  return (
    <div ref={box} className="mx-auto overflow-hidden rounded-lg bg-white shadow-md" style={{ width, height: width * ratio }}>
      <canvas ref={canvas} className="h-full w-full" />
    </div>
  );
}

export default function PdfViewer({ url }) {
  const container = useRef();
  const [pdf, setPdf] = useState(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [baseWidth, setBaseWidth] = useState(0);

  useEffect(() => {
    const task = pdfjs.getDocument({ url, isEvalSupported: false });
    task.promise.then(setPdf, (e) => setError(e.message));
    return () => { task.destroy(); };
  }, [url]);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setBaseWidth(Math.min(e.contentRect.width - 32, 900)));
    ro.observe(container.current);
    return () => ro.disconnect();
  }, []);

  const width = Math.round(baseWidth * zoom);
  return (
    <div className="relative flex h-full flex-col">
      <div ref={container} className="flex-1 space-y-4 overflow-auto p-4">
        {error && <p className="p-8 text-center text-sm text-red-500">Impossible d’afficher le PDF : {error}</p>}
        {!pdf && !error && <div className="grid h-64 place-items-center"><Loader2 className="animate-spin text-indigo-500" /></div>}
        {pdf && width > 0 && Array.from({ length: pdf.numPages }, (_, i) => <Page key={i} pdf={pdf} number={i + 1} width={width} />)}
      </div>
      {pdf && (
        <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-zinc-200 bg-white/90 p-1 shadow-lg backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/90">
          <button className="rounded-full p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Dézoomer" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}><ZoomOut size={16} /></button>
          <span className="w-20 text-center text-xs tabular-nums text-zinc-500">{Math.round(zoom * 100)} % · {pdf.numPages} p.</span>
          <button className="rounded-full p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Zoomer" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}><ZoomIn size={16} /></button>
        </div>
      )}
    </div>
  );
}
