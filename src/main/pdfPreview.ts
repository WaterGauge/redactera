import type { BrowserWindow, IpcMain, Protocol } from 'electron';
import { pathToFileURL } from 'url';
import type { PathValidator } from './pathValidator';
import { createPdfPreviewUrl } from '../pdfPreviewUrl';
import { PDF_IMPORT_LIMITS } from '../types/fileImport';

export function registerPdfPreviewScheme(protocol: Pick<Protocol, 'registerSchemesAsPrivileged'>): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'pdf-safe',
    privileges: {
      // Preserve the existing encoded absolute-path URL. It has no web origin
      // or relative resources, so it intentionally is not a standard scheme.
      standard: false,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
      allowServiceWorkers: false,
    },
  }]);
}

export function createPdfPreviewHandler(deps: {
  pathValidator: Pick<PathValidator, 'resolvePdfSafePathFromRequest' | 'isResolvedPathAllowed'>;
  isClosing: () => boolean;
  fetchFile: (fileUrl: string) => Promise<Response>;
}): (request: Pick<Request, 'url'>) => Response | Promise<Response> {
  return request => {
    if (deps.isClosing()) return new Response('Closing', { status: 503 });
    const resolvedPath = deps.pathValidator.resolvePdfSafePathFromRequest(request.url);
    if (!resolvedPath || !deps.pathValidator.isResolvedPathAllowed(resolvedPath)) {
      return new Response('Forbidden', { status: 403 });
    }
    return deps.fetchFile(pathToFileURL(resolvedPath).href);
  };
}

// Preserve the existing path-import budget for optional full-document preview.
// It bounds admitted bytes, not total PDF.js/IPC memory or document complexity.
export const PREVIEW_MAX_BYTES = PDF_IMPORT_LIMITS.fileBytes;

async function readBoundedPreview(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new Error('Rejected');
  const reader = response.body.getReader();
  let completed = false;
  try {
    const length = response.headers.get('content-length');
    if (!response.ok || (length !== null && (!/^\d+$/.test(length) ||
        !Number.isSafeInteger(Number(length)) || Number(length) > limit))) throw new Error('Rejected');
    let buffer = new Uint8Array(0);
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.byteLength) continue;
      if (value.byteLength > limit - bytes || (length !== null && value.byteLength > Number(length) - bytes)) throw new Error('Rejected');
      const required = bytes + value.byteLength;
      if (required > buffer.length) {
        const next = new Uint8Array(Math.min(limit, Math.max(required, 65536, buffer.length * 2)));
        next.set(buffer.subarray(0, bytes));
        buffer = next;
      }
      buffer.set(value, bytes);
      bytes = required;
    }
    if (length !== null && Number(length) !== bytes) throw new Error('Rejected');
    completed = true;
    return buffer.length === bytes ? buffer : buffer.slice(0, bytes);
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// Cross-origin fetch to a non-CORS scheme is intentionally blocked by modern
// Electron. Keep the scheme private and reuse its exact-file authorization in
// an asynchronous, typed bridge owned only by the trusted main document.
export function registerPdfPreviewReader(deps: {
  ipcMain: Pick<IpcMain, 'handle'>;
  mainWindowProvider: () => BrowserWindow | null;
  pageUrl: string;
  handler: ReturnType<typeof createPdfPreviewHandler>;
  maxBytes?: number;
}): void {
  // Forge's entry contains raw spaces/Unicode in the bundle path; Chromium
  // serializes the same document as an escaped URL. Compare full serialized
  // URLs, while retaining the exact document, query and fragment boundary.
  const pageUrl = new URL(deps.pageUrl).href;
  const limit = deps.maxBytes ?? PREVIEW_MAX_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > PREVIEW_MAX_BYTES) throw new Error('Invalid preview byte limit');
  let active = false;
  deps.ipcMain.handle('pdf:readPreview', async (event, filePath: unknown) => {
    let acquired = false;
    try {
      const window = deps.mainWindowProvider();
      const owner = window && !window.isDestroyed() ? window.webContents : null;
      const frame = event.senderFrame;
      if (!owner || owner.isDestroyed() || event.sender !== owner || !frame || frame !== owner.mainFrame ||
          new URL(frame.url).href !== pageUrl || typeof filePath !== 'string') throw new Error('Rejected');
      // A rapid repeated request must not multiply full-document buffers.
      // Reject while the earlier read settles; optional preview can be retried.
      if (active) throw new Error('Rejected');
      acquired = true; active = true;
      const response = await deps.handler({ url: createPdfPreviewUrl(filePath) });
      return await readBoundedPreview(response, limit);
    } catch {
      // Native read failures can contain a document path. Keep rejection data
      // independent of the requested file and underlying operating system.
      throw new Error('Preview read rejected');
    } finally {
      if (acquired) active = false;
    }
  });
}
