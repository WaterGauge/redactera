import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const library = vi.hoisted(() => ({ getDocument: vi.fn(), PDFWorker: { create: vi.fn(() => ({ promise: Promise.resolve(), destroy: vi.fn() })) } }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => library);
import { PdfPreview } from '../PdfPreview';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const paint = () => ({
  getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
  render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'CURRENT FILE TEXT', hasEOL: true }] }),
});
let source: ReturnType<typeof paint>;
let pdf: { numPages: number; getPage: ReturnType<typeof vi.fn> };
let destroy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  source = paint(); pdf = { numPages: 2, getPage: vi.fn().mockResolvedValue(source) };
  destroy = vi.fn().mockResolvedValue(undefined);
  library.getDocument.mockReset().mockReturnValue({ promise: Promise.resolve(pdf), destroy });
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(new Uint8Array([37, 80, 68, 70]))));
  vi.stubGlobal('electronAPI', { readPdfPreview: vi.fn().mockResolvedValue(new Uint8Array([37, 80, 68, 70])) });
  vi.stubGlobal('Worker', class { addEventListener() { /* PDFWorker is mocked in unit tests. */ } terminate() { /* Native worker shutdown is checked in Electron. */ } });
  const OriginalURL = URL;
  vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL() { return 'blob:unit-worker'; } static revokeObjectURL() { /* No native URL in jsdom. */ } });
  vi.stubGlobal('ResizeObserver', class { observe() { /* Width is sampled on mount as well. */ } disconnect() { /* No observer survives unmount. */ } });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const mount = () => render(<PdfPreview filePath="/fixture/中文 #?.pdf" location={null} disabled={false} />);
const loaded = () => screen.findByText('CURRENT FILE TEXT');

it('fails explicitly if the real worker cannot start, without parsing on the UI thread', async () => {
  const startup = Promise.reject(new Error('WORKER PRIVATE ERROR')); void startup.catch(() => undefined);
  library.PDFWorker.create.mockReturnValueOnce({ promise: startup, destroy: vi.fn() });
  mount(); await screen.findByText(/无法预览 PDF/);
  expect(library.getDocument).not.toHaveBeenCalled();
  expect(document.body).not.toHaveTextContent('WORKER PRIVATE ERROR');
});

it('requests the exact filename through the asynchronous bridge and uses packaged resources', async () => {
  mount(); await loaded();
  expect(window.electronAPI.readPdfPreview).toHaveBeenCalledExactlyOnceWith('/fixture/中文 #?.pdf');
  expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).startsWith('pdf-safe:'))).toBe(true);
  expect(library.PDFWorker.create).toHaveBeenCalledWith({ port: expect.any(Worker) });
  expect(library.getDocument).toHaveBeenCalledWith(expect.objectContaining({ cMapUrl: expect.stringMatching(/\/pdf-assets\/cmaps\/$/), wasmUrl: expect.stringMatching(/\/pdf-assets\/wasm\/$/) }));
  expect(library.getDocument).toHaveBeenCalledWith(expect.objectContaining({ data: expect.any(Uint8Array), enableXfa: false, stopAtErrors: true, useWorkerFetch: false, cMapPacked: true }));
  expect(screen.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible();
});

it('has bounded, labelled page and zoom controls and disables them during final writes', async () => {
  const view = mount(); await loaded();
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(pdf.getPage).toHaveBeenLastCalledWith(2));
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('预览页码'), { target: { value: '999' } });
  expect(pdf.getPage).not.toHaveBeenCalledWith(999);
  fireEvent.change(screen.getByLabelText('预览缩放'), { target: { value: '2' } });
  await waitFor(() => expect(source.render).toHaveBeenCalledWith(expect.objectContaining({ viewport: { width: 1200, height: 1600 } })));
  view.rerender(<PdfPreview filePath="/fixture/中文 #?.pdf" location={null} disabled />);
  expect(screen.getByLabelText('预览缩放')).toBeDisabled(); expect(screen.getByLabelText('预览页码')).toBeDisabled();
});

it('navigates to real warning pages without inventing a page when the backend location is outside the document', async () => {
  const view = mount(); await loaded();
  view.rerender(<PdfPreview filePath="/fixture/中文 #?.pdf" location={{ page: 2, sequence: 1 }} disabled={false} />);
  await waitFor(() => expect(pdf.getPage).toHaveBeenLastCalledWith(2));
  view.rerender(<PdfPreview filePath="/fixture/中文 #?.pdf" location={{ page: 20, sequence: 2 }} disabled={false} />);
  expect(screen.getByRole('status')).toHaveTextContent('提示中的页码超出这份 PDF'); expect(pdf.getPage).not.toHaveBeenCalledWith(20);
});

it('does not parse a rejected read, does not expose its error detail, and permits an explicit retry', async () => {
  vi.mocked(window.electronAPI.readPdfPreview).mockRejectedValueOnce(new Error('PRIVATE ERROR DETAIL'));
  mount(); await screen.findByText(/无法预览 PDF/);
  expect(library.getDocument).not.toHaveBeenCalled(); expect(document.body).not.toHaveTextContent('PRIVATE ERROR DETAIL');
  fireEvent.click(screen.getByRole('button', { name: '重新加载' })); await loaded();
});

it('destroys old loads and cannot show late original text after switching to a result', async () => {
  const old = deferred<typeof pdf>();
  library.getDocument.mockReturnValueOnce({ promise: old.promise, destroy });
  const view = mount(); await waitFor(() => expect(library.getDocument).toHaveBeenCalledTimes(1));
  view.rerender(<PdfPreview filePath="/fixture/result.pdf" location={null} disabled={false} />);
  await loaded(); expect(destroy).toHaveBeenCalled();
  const stale = { numPages: 50, getPage: vi.fn().mockResolvedValue({ ...paint(), getTextContent: async () => ({ items: [{ str: 'OLD ORIGINAL SECRET' }] }) }) };
  await act(async () => old.resolve(stale));
  expect(stale.getPage).not.toHaveBeenCalled(); expect(document.body).not.toHaveTextContent('OLD ORIGINAL SECRET');
});

it('cancels stale page rendering and never retains its auxiliary text in the current page', async () => {
  const first = deferred<void>(); const cancel = vi.fn();
  source.render.mockReturnValueOnce({ promise: first.promise, cancel });
  mount(); await waitFor(() => expect(source.render).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: '下一页' })); await loaded();
  expect(cancel).toHaveBeenCalled();
  await act(async () => first.resolve());
  expect(screen.getByLabelText('预览页码')).toHaveValue(2);
});

it('reports only a painted result page, including a selected mask on the same page', async () => {
  const pending = deferred<void>(); source.render.mockReturnValueOnce({ promise: pending.promise, cancel: vi.fn() });
  const rendered = vi.fn(), failed = vi.fn();
  const view = render(<PdfPreview filePath="/result.pdf" location={null} disabled={false} onPageRendered={rendered} onPreviewError={failed} />);
  await waitFor(() => expect(source.render).toHaveBeenCalled()); expect(rendered).not.toHaveBeenCalled();
  await act(async () => pending.resolve()); await waitFor(() => expect(rendered).toHaveBeenCalledWith(1, 2, undefined));
  const region = { id: 'r1', page: 1, origin: 'keyword' as const, keywords: ['SECRET'], polygon: [[.1, .2], [.4, .2], [.4, .3], [.1, .3]] as Array<[number, number]> };
  view.rerender(<PdfPreview filePath="/result.pdf" location={{ page: 1, sequence: 1 }} disabled={false} region={region} onPageRendered={rendered} />);
  await waitFor(() => expect(rendered).toHaveBeenLastCalledWith(1, 2, 'r1'));
  expect(screen.getByTestId('pdf-region-marker').querySelector('polygon')).toHaveAttribute('points', '0.1,0.2 0.4,0.2 0.4,0.3 0.1,0.3');
  expect(document.body).not.toHaveTextContent('SECRET'); expect(failed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '下一页' })); await waitFor(() => expect(rendered).toHaveBeenLastCalledWith(2, 2, undefined));
  expect(screen.queryByTestId('pdf-region-marker')).not.toBeInTheDocument();
});

it('does not count a failed preview as a visited page', async () => {
  const rendered = vi.fn(), failed = vi.fn();
  vi.mocked(window.electronAPI.readPdfPreview).mockRejectedValueOnce(new Error('private error'));
  render(<PdfPreview filePath="/result.pdf" location={null} disabled={false} onPageRendered={rendered} onPreviewError={failed} />);
  await waitFor(() => expect(failed).toHaveBeenCalledOnce()); expect(rendered).not.toHaveBeenCalled();
});


it('does not parse bytes from a superseded asynchronous bridge read', async () => {
  const old = deferred<Uint8Array>();
  vi.mocked(window.electronAPI.readPdfPreview).mockReturnValueOnce(old.promise);
  const view = mount();
  view.rerender(<PdfPreview filePath="/fixture/result.pdf" location={null} disabled={false} />);
  await loaded(); expect(library.getDocument).toHaveBeenCalledTimes(1);
  await act(async () => old.resolve(new Uint8Array([1, 2, 3])));
  expect(library.getDocument).toHaveBeenCalledTimes(1);
});
