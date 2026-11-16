import React, { useEffect, useRef, useState } from 'react';
import { getDocument, PDFWorker, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ReviewRegion } from '../types/processing';

const assets = new URL('./pdf-assets/', document.baseURI).href;
let workerSource: Promise<string> | undefined;
function loadWorkerSource(): Promise<string> {
  return workerSource ??= fetch(assets + 'pdf.worker.mjs', { credentials: 'omit', redirect: 'error' })
    .then(response => { if (!response.ok) throw new Error('Worker read rejected'); return response.text(); })
    .catch(error => { workerSource = undefined; throw error; });
}
const ZOOMS = ['fit', '0.5', '0.75', '1', '1.25', '1.5', '2'] as const;
const MAX_PAGE_TEXT_UNITS = 1024 * 1024; // optional auxiliary text, not a PDF processing limit
const PAGE_TEXT_LIMIT = '本页文字量超过辅助阅读容量，页面图像仍可查看。';
const PREVIEW_ERROR = '无法预览 PDF。请重新加载；若仍失败，请检查文件是否过大、损坏、加密或无权读取。';

export function PdfPreview({ filePath, location, disabled, region, onPageRendered, onPreviewError }: {
  filePath: string;
  location: { page: number; sequence: number } | null;
  disabled: boolean;
  region?: ReviewRegion | null;
  onPageRendered?: (page: number, pageCount: number, regionId?: string) => void;
  onPreviewError?: () => void;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<string>('fit');
  const [width, setWidth] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [pageNotice, setPageNotice] = useState('');
  const [rendering, setRendering] = useState(true);
  const [text, setText] = useState('');
  const [textNotice, setTextNotice] = useState('');
  const [painted, setPainted] = useState<{ pdf: PDFDocumentProxy; page: number; zoom: string; width: number; attempt: number; viewWidth: number; viewHeight: number } | null>(null);
  const callbacks = useRef({ onPageRendered, onPreviewError });
  callbacks.current = { onPageRendered, onPreviewError };
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = viewport.current;
    if (!container) return;
    const observer = new ResizeObserver(() => setWidth(container.clientWidth));
    observer.observe(container); setWidth(container.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let stopped = false;
    let task: ReturnType<typeof getDocument> | undefined;
    let worker: PDFWorker | undefined;
    let port: Worker | undefined;
    let workerUrl: string | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    setPdf(null); setError(''); setText(''); setTextNotice(''); setPage(1); setRendering(true); setPainted(null);
    void (async () => {
      // Main asynchronously reads through the existing exact-file gate. Only
      // this trusted main document can use the bridge; no cross-origin read
      // privileges, synchronous filesystem IO or base64 transport are needed.
      const data = await window.electronAPI.readPdfPreview(filePath);
      if (stopped) return;
      const code = await loadWorkerSource();
      if (stopped) return;
      // A file:// page has an opaque origin. PDF.js's URL wrapper can fall
      // back to parsing on the UI thread there. Supply our own packaged worker
      // bytes so startup either uses a real worker or fails explicitly.
      workerUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      port = new Worker(workerUrl, { type: 'module' });
      worker = PDFWorker.create({ port });
      await Promise.race([worker.promise, new Promise<never>((_resolve, reject) => {
        port?.addEventListener('error', () => reject(new Error('Worker start failed')), { once: true });
        startupTimer = setTimeout(() => reject(new Error('Worker start timed out')), 15_000);
      })]).finally(() => clearTimeout(startupTimer));
      if (stopped) return;
      // PDF.js 6 has removed the eval option and code-generation path. The
      // production CSP continues to prohibit JavaScript eval.
      task = getDocument({ data, worker, enableXfa: false, stopAtErrors: true,
        cMapUrl: assets + 'cmaps/', cMapPacked: true, standardFontDataUrl: assets + 'standard_fonts/',
        wasmUrl: assets + 'wasm/', iccUrl: assets + 'iccs/', useWorkerFetch: false, verbosity: 0 });
      const loaded = await task.promise;
      if (!stopped) setPdf(loaded);
    })().catch(() => {
      if (!stopped) {
        void task?.destroy().catch(() => undefined); worker?.destroy(); port?.terminate();
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        setError(PREVIEW_ERROR); setRendering(false);
      }
    });
    return () => {
      stopped = true; clearTimeout(startupTimer);
      void task?.destroy().catch(() => undefined);
      worker?.destroy(); port?.terminate();
      if (workerUrl) URL.revokeObjectURL(workerUrl);
    };
  }, [filePath, attempt]);

  useEffect(() => {
    if (!pdf || !location) return;
    if (Number.isSafeInteger(location.page) && location.page > 0 && location.page <= pdf.numPages) {
      setPage(location.page); setPageNotice('');
      viewport.current?.scrollTo({ top: 0, left: 0 });
    } else setPageNotice('提示中的页码超出这份 PDF，请检查原文。');
  }, [pdf, location?.page, location?.sequence]);

  useEffect(() => {
    if (!pdf || width <= 0 || !canvas.current) return;
    let stopped = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let textReader: ReadableStreamDefaultReader<{ items: Array<{ str?: string; hasEOL?: boolean }> }> | undefined;
    const target = canvas.current;
    setRendering(true); setText(''); setTextNotice(''); setError(''); setPainted(null);
    void (async () => {
      const source = await pdf.getPage(page);
      if (stopped) return;
      const natural = source.getViewport({ scale: 1 });
      if (!Number.isFinite(natural.width) || !Number.isFinite(natural.height) || natural.width <= 0 || natural.height <= 0) throw new Error('Invalid preview geometry');
      const scale = zoom === 'fit' ? Math.max(0.01, (width - 32) / natural.width) : Number(zoom);
      const view = source.getViewport({ scale });
      if (!Number.isFinite(view.width) || !Number.isFinite(view.height) || view.width <= 0 || view.height <= 0) throw new Error('Invalid preview geometry');
      // Bound the backing bitmap, while preserving the visible aspect ratio.
      const ratio = Math.min(window.devicePixelRatio || 1, 8192 / view.width, 8192 / view.height, Math.sqrt(16_777_216 / (view.width * view.height)));
      target.width = Math.max(1, Math.floor(view.width * ratio)); target.height = Math.max(1, Math.floor(view.height * ratio));
      target.style.width = `${view.width}px`; target.style.height = `${view.height}px`;
      renderTask = source.render({ canvas: target, viewport: view, transform: [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (stopped) return;
      // Stream optional reading text instead of collecting an unbounded page
      // object graph. Do not show a partial string as if it were the full page.
      const reader = source.streamTextContent().getReader() as ReadableStreamDefaultReader<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
      textReader = reader;
      let pageText = '', overLimit = false;
      try {
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done || stopped) break;
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue;
            if (item.str.length + 1 > MAX_PAGE_TEXT_UNITS - pageText.length) { overLimit = true; break; }
            pageText += item.str + (item.hasEOL ? '\n' : ' ');
          }
          if (overLimit) { await reader.cancel(); break; }
        }
      } finally {
        textReader = undefined;
        reader.releaseLock();
      }
      if (stopped) return;
      if (overLimit) setTextNotice(PAGE_TEXT_LIMIT);
      else setText(pageText);
      setPainted({ pdf, page, zoom, width, attempt, viewWidth: view.width, viewHeight: view.height });
      setRendering(false);
    })().catch(() => { if (!stopped) { setError(PREVIEW_ERROR); setRendering(false); } });
    return () => { stopped = true; renderTask?.cancel(); void textReader?.cancel().catch(() => undefined); };
  }, [pdf, page, zoom, width, attempt]);

  const ready = !error && !rendering && painted?.pdf === pdf && painted?.page === page &&
    painted?.zoom === zoom && painted?.width === width && painted?.attempt === attempt;
  const visibleRegion = ready && region?.page === page ? region : null;
  useEffect(() => {
    if (ready && pdf) callbacks.current.onPageRendered?.(page, pdf.numPages, visibleRegion?.id);
  }, [ready, pdf, page, visibleRegion?.id, location?.sequence, onPageRendered]);
  useEffect(() => { if (error) callbacks.current.onPreviewError?.(); }, [error]);

  useEffect(() => {
    if (!visibleRegion) return;
    const frame = canvas.current?.parentElement;
    if (!frame || !viewport.current) return;
    const x = visibleRegion.polygon.reduce((sum, point) => sum + point[0], 0) / visibleRegion.polygon.length;
    const y = visibleRegion.polygon.reduce((sum, point) => sum + point[1], 0) / visibleRegion.polygon.length;
    const frameBounds = frame.getBoundingClientRect(), viewportBounds = viewport.current.getBoundingClientRect();
    viewport.current.scrollTo({ left: Math.max(0, viewport.current.scrollLeft + frameBounds.left - viewportBounds.left + x * frameBounds.width - viewport.current.clientWidth / 2),
      top: Math.max(0, viewport.current.scrollTop + frameBounds.top - viewportBounds.top + y * frameBounds.height - viewport.current.clientHeight / 2) });
  }, [visibleRegion, location?.sequence]);

  const changePage = (next: number) => {
    if (!pdf || disabled || !Number.isSafeInteger(next) || next < 1 || next > pdf.numPages) return;
    setPage(next); setPageNotice(''); viewport.current?.scrollTo({ top: 0, left: 0 });
  };
  return <section className="pdf-viewer" aria-label="PDF 预览" aria-busy={rendering}>
    <div className="pdf-controls">
      <button type="button" aria-label="上一页" disabled={disabled || !pdf || page <= 1} onClick={() => changePage(page - 1)}>上一页</button>
      <label>页码 <input aria-label="预览页码" type="number" min={1} max={pdf?.numPages ?? 1} value={page}
        disabled={disabled || !pdf} onChange={event => changePage(Number(event.target.value))} /></label>
      <span> / {pdf?.numPages ?? '—'}</span>
      <button type="button" aria-label="下一页" disabled={disabled || !pdf || page >= pdf.numPages} onClick={() => changePage(page + 1)}>下一页</button>
      <label>缩放 <select aria-label="预览缩放" disabled={disabled || !pdf} value={zoom} onChange={event => setZoom(event.target.value)}>
        {ZOOMS.map(value => <option key={value} value={value}>{value === 'fit' ? '适合宽度' : `${Number(value) * 100}%`}</option>)}
      </select></label>
    </div>
    <div className="pdf-status" role="status" aria-live="polite">{error || pageNotice || (!ready ? '正在加载页面…' : `第 ${page} 页，共 ${pdf?.numPages} 页${visibleRegion ? '，已标出所选遮盖区域' : ''}`)}</div>
    {error && <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setAttempt(value => value + 1)}>重新加载</button>}
    <div ref={viewport} className="pdf-viewport" tabIndex={0} aria-label="PDF 页面滚动区">
      <div className="pdf-page-frame" style={{ width: ready ? painted.viewWidth : undefined, height: ready ? painted.viewHeight : undefined }}>
        <canvas key={`${page}:${zoom}:${width}:${attempt}`} ref={canvas} role="img" aria-label={`PDF 第 ${page} 页`} hidden={!ready} />
        {visibleRegion && <svg className="pdf-region-marker" data-testid="pdf-region-marker" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <polygon points={visibleRegion.polygon.map(point => point.join(',')).join(' ')} className="marker-halo" vectorEffect="non-scaling-stroke" />
          <polygon points={visibleRegion.polygon.map(point => point.join(',')).join(' ')} className="marker-outline" vectorEffect="non-scaling-stroke" />
        </svg>}
      </div>
    </div>
    {ready && textNotice && <p role="status">{textNotice}</p>}
    {text && !error && <details className="pdf-page-text"><summary>本页文字</summary><p>文字顺序可能与页面不同，版式以页面为准。</p><pre>{text}</pre></details>}
  </section>;
}
