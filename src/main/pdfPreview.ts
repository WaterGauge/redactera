import type { BrowserWindow, IpcMain, Protocol } from 'electron';
import { pathToFileURL } from 'url';
import type { PathValidator } from './pathValidator';
import { createPdfPreviewUrl } from '../pdfPreviewUrl';

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

// Cross-origin fetch to a non-CORS scheme is intentionally blocked by modern
// Electron. Keep the scheme private and reuse its exact-file authorization in
// an asynchronous, typed bridge owned only by the trusted main document.
export function registerPdfPreviewReader(deps: {
  ipcMain: Pick<IpcMain, 'handle'>;
  mainWindowProvider: () => BrowserWindow | null;
  pageUrl: string;
  handler: ReturnType<typeof createPdfPreviewHandler>;
}): void {
  // Forge's entry contains raw spaces/Unicode in the bundle path; Chromium
  // serializes the same document as an escaped URL. Compare full serialized
  // URLs, while retaining the exact document, query and fragment boundary.
  const pageUrl = new URL(deps.pageUrl).href;
  deps.ipcMain.handle('pdf:readPreview', async (event, filePath: unknown) => {
    try {
      const window = deps.mainWindowProvider();
      const owner = window && !window.isDestroyed() ? window.webContents : null;
      const frame = event.senderFrame;
      if (!owner || owner.isDestroyed() || event.sender !== owner || !frame || frame !== owner.mainFrame ||
          new URL(frame.url).href !== pageUrl || typeof filePath !== 'string') throw new Error('Rejected');
      const response = await deps.handler({ url: createPdfPreviewUrl(filePath) });
      if (!response.ok) throw new Error('Rejected');
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      // Native read failures can contain a document path. Keep rejection data
      // independent of the requested file and underlying operating system.
      throw new Error('Preview read rejected');
    }
  });
}
