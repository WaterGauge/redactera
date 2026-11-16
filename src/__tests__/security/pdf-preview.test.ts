// @vitest-environment node
import path from 'node:path';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createPathValidator } from '../../main/pathValidator';
import { createPdfPreviewHandler, registerPdfPreviewReader, registerPdfPreviewScheme } from '../../main/pdfPreview';
import { createPdfPreviewUrl } from '../../pdfPreviewUrl';

describe('authorized PDF preview protocol', () => {
  function setup() {
    const validator = createPathValidator();
    const fetchFile = vi.fn(async () => new Response('%PDF-fixture', { headers: { 'content-type': 'application/pdf' } }));
    const state = { closing: false };
    return { validator, fetchFile, state, handler: createPdfPreviewHandler({
      pathValidator: validator, fetchFile, isClosing: () => state.closing,
    }) };
  }

  it.each(['/tmp/original.pdf', '/tmp/中文 100% #? 名称.pdf', '/tmp/result/processed.pdf'])(
    'serves the exact authorized file: %s', async file => {
      const { validator, handler, fetchFile } = setup();
      const resolved = validator.addAllowedPath(file);
      if (!resolved) throw new Error('Fixture path must resolve');
      const response = await handler({ url: `pdf-safe://${encodeURIComponent(file)}` });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/pdf');
      expect(await response.text()).toBe('%PDF-fixture');
      expect(fetchFile).toHaveBeenCalledExactlyOnceWith(pathToFileURL(resolved).href);
    });

  it.each([
    'pdf-safe://%2Ftmp%2Fnot-selected.pdf',
    'pdf-safe://%2Ftmp%2Fauthorized.pdf%2F..%2Fsecret.pdf',
    'pdf-safe://%2Ftmp%2Fauthorized.pdf%00',
    'pdf-safe://%E0%A4%A',
    'file:///tmp/authorized.pdf',
    'https://example.test/document.pdf',
  ])('refuses unauthorized or malformed requests without file IO: %s', async url => {
    const { validator, handler, fetchFile } = setup();
    validator.addAllowedPath('/tmp/authorized.pdf');
    expect((await handler({ url })).status).toBe(403);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('normalizes before checking the exact allowlist', async () => {
    const { validator, handler, fetchFile } = setup();
    validator.addAllowedPath('/tmp/authorized.pdf');
    expect((await handler({ url: `pdf-safe://${encodeURIComponent('/tmp/sub/../authorized.pdf')}` })).status).toBe(200);
    expect(fetchFile).toHaveBeenCalledWith(pathToFileURL(path.resolve('/tmp/authorized.pdf')).href);
  });

  it('stops new reads during shutdown, including previously authorized files', async () => {
    const { validator, handler, fetchFile, state } = setup();
    validator.addAllowedPath('/tmp/authorized.pdf');
    state.closing = true;
    expect((await handler({ url: 'pdf-safe://%2Ftmp%2Fauthorized.pdf' })).status).toBe(503);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('separates viewer navigation from a filename containing a literal hash', async () => {
    const { validator, handler, fetchFile } = setup();
    const file = '/tmp/中文 100% #page=999?.pdf';
    validator.addAllowedPath(file);
    const url = createPdfPreviewUrl(file, 2);
    expect(url).toContain('%23page%3D999%3F.pdf#page=2');
    expect((await handler({ url })).status).toBe(200);
    expect(fetchFile).toHaveBeenCalledWith(pathToFileURL(path.resolve(file)).href);
  });

  it('does not grant another file through a page fragment', async () => {
    const { validator, handler, fetchFile } = setup();
    validator.addAllowedPath('/tmp/authorized.pdf');
    expect((await handler({ url: createPdfPreviewUrl('/tmp/secret.pdf', 2) })).status).toBe(403);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, 1.5, NaN, Infinity])('does not construct a page fragment for invalid page %s', page => {
    expect(createPdfPreviewUrl('/tmp/document.pdf', page)).toBe('pdf-safe://%2Ftmp%2Fdocument.pdf');
  });

  it('registers the viewer protocol without bypassing CSP or enabling a web origin', () => {
    const registerSchemesAsPrivileged = vi.fn();
    registerPdfPreviewScheme({ registerSchemesAsPrivileged });
    expect(registerSchemesAsPrivileged).toHaveBeenCalledExactlyOnceWith([{
      scheme: 'pdf-safe', privileges: {
        standard: false, secure: true, supportFetchAPI: true, stream: true,
        bypassCSP: false, allowServiceWorkers: false,
      },
    }]);
  });
});


describe('trusted asynchronous PDF preview bridge', () => {
  function setup(pageUrl = 'file:///ui/index.html', actualUrl = pageUrl, maxBytes?: number) {
    const validator = createPathValidator();
    const fetchFile = vi.fn(async () => new Response('%PDF-fixture'));
    const state = { closing: false, destroyed: false };
    const frame = { url: actualUrl };
    const owner = { mainFrame: frame, isDestroyed: () => state.destroyed };
    const window = { webContents: owner, isDestroyed: () => state.destroyed };
    let reader!: Parameters<IpcMain['handle']>[1];
    registerPdfPreviewReader({
      ipcMain: { handle: (_channel, listener) => { reader = listener; } },
      mainWindowProvider: () => window as unknown as BrowserWindow,
      pageUrl, maxBytes,
      handler: createPdfPreviewHandler({ pathValidator: validator, fetchFile, isClosing: () => state.closing }),
    });
    const event = { sender: owner, senderFrame: frame };
    const read = (file: unknown, incoming = event) => reader(incoming as unknown as IpcMainInvokeEvent, file);
    return { validator, fetchFile, state, frame, owner, event, read };
  }
  it('asynchronously returns only the exact selected filename, including literal URL delimiters', async () => {
    const h = setup(), file = '/tmp/中文 100% #? 名称.pdf';
    h.validator.addAllowedPath(file);
    const data = await h.read(file);
    expect(data).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(data)).toBe('%PDF-fixture');
    expect(h.fetchFile).toHaveBeenCalledExactlyOnceWith(pathToFileURL(path.resolve(file)).href);
  });
  it.each([
    'file:///Applications/PDF Desensitization.app/Contents/Resources/app.asar/.webpack/renderer/main_window/index.html',
    'file:///tmp/中文目录/Redactera E2E.app/Contents/Resources/app.asar/.webpack/renderer/main_window/index.html',
  ])('recognizes Chromium serialization of the exact packaged page: %s', async pageUrl => {
    const h = setup(pageUrl, new URL(pageUrl).href);
    h.validator.addAllowedPath('/tmp/selected.pdf');
    expect(new TextDecoder().decode(await h.read('/tmp/selected.pdf'))).toBe('%PDF-fixture');
    expect(h.fetchFile).toHaveBeenCalledOnce();
  });
  it.each(['index.html.evil', 'other.html', 'index.html?other', 'index.html#other'])(
    'does not treat a different packaged document as the trusted page: %s', async name => {
      const base = 'file:///Applications/PDF Desensitization.app/Contents/Resources/app.asar/.webpack/renderer/main_window/';
      const h = setup(base + 'index.html', new URL(base + name).href);
      h.validator.addAllowedPath('/tmp/selected.pdf');
      await expect(h.read('/tmp/selected.pdf')).rejects.toThrow('Preview read rejected');
      expect(h.fetchFile).not.toHaveBeenCalled();
    });
  it.each(['/tmp/secret.pdf', '/tmp/selected.pdf/../secret.pdf', '/tmp/selected.pdf\0', null, {}])(
    'refuses unauthorized or invalid bridge input without reading: %s', async file => {
      const h = setup(); h.validator.addAllowedPath('/tmp/selected.pdf');
      await expect(h.read(file)).rejects.toThrow('Preview read rejected');
      expect(h.fetchFile).not.toHaveBeenCalled();
    });
  it.each(['foreign-window', 'subframe', 'remote-navigation', 'destroyed-window', 'closing'])(
    'refuses reads from an invalid lifecycle or caller: %s', async condition => {
      const h = setup(); h.validator.addAllowedPath('/tmp/selected.pdf');
      const event = { ...h.event };
      if (condition === 'foreign-window') event.sender = { ...h.owner };
      if (condition === 'subframe') event.senderFrame = { ...h.frame };
      if (condition === 'remote-navigation') h.frame.url = 'https://example.test/';
      if (condition === 'destroyed-window') h.state.destroyed = true;
      if (condition === 'closing') h.state.closing = true;
      await expect(h.read('/tmp/selected.pdf', event)).rejects.toThrow('Preview read rejected');
      expect(h.fetchFile).not.toHaveBeenCalled();
    });
  it('does not disclose native file read error details over IPC', async () => {
    const h = setup(); h.validator.addAllowedPath('/tmp/selected.pdf');
    h.fetchFile.mockRejectedValueOnce(new Error('PRIVATE DOCUMENT PATH'));
    await expect(h.read('/tmp/selected.pdf')).rejects.toThrow(/^Preview read rejected$/);
  });
  it('accepts exact-limit streamed bytes and does not trust an absent length', async () => {
    const h = setup(undefined, undefined, 8); h.validator.addAllowedPath('/tmp/selected.pdf');
    h.fetchFile.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4, 5, 6, 7, 8])); controller.close();
    } })));
    expect(await h.read('/tmp/selected.pdf')).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  });
  it.each([undefined, '7', '9', 'invalid'])('rejects oversized streams or lengths (%s), cancels and allows a later read', async length => {
    const h = setup(undefined, undefined, 8); h.validator.addAllowedPath('/tmp/selected.pdf');
    const cancel = vi.fn();
    h.fetchFile.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(7)); controller.enqueue(new Uint8Array(2));
    }, cancel }), { headers: length === undefined ? {} : { 'content-length': length } }));
    await expect(h.read('/tmp/selected.pdf')).rejects.toThrow('Preview read rejected');
    expect(cancel).toHaveBeenCalledOnce();
    h.fetchFile.mockResolvedValueOnce(new Response('good'));
    expect(new TextDecoder().decode(await h.read('/tmp/selected.pdf'))).toBe('good');
  });
  it('rejects truncated declared content and read failure', async () => {
    const h = setup(undefined, undefined, 8); h.validator.addAllowedPath('/tmp/selected.pdf');
    h.fetchFile.mockResolvedValueOnce(new Response('short', { headers: { 'content-length': '8' } }));
    await expect(h.read('/tmp/selected.pdf')).rejects.toThrow('Preview read rejected');
    h.fetchFile.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error('PRIVATE')); } })));
    await expect(h.read('/tmp/selected.pdf')).rejects.toThrow(/^Preview read rejected$/);
  });
  it('allows only one active read and does not release the active slot on a competing request', async () => {
    const h = setup(undefined, undefined, 8); h.validator.addAllowedPath('/tmp/selected.pdf');
    let finish!: (response: Response) => void;
    h.fetchFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = h.read('/tmp/selected.pdf');
    await expect(h.read('/tmp/selected.pdf')).rejects.toThrow('Preview read rejected');
    await expect(h.read('/tmp/selected.pdf')).rejects.toThrow('Preview read rejected');
    expect(h.fetchFile).toHaveBeenCalledOnce();
    finish(new Response('first')); expect(new TextDecoder().decode(await first)).toBe('first');
    h.fetchFile.mockResolvedValueOnce(new Response('next'));
    expect(new TextDecoder().decode(await h.read('/tmp/selected.pdf'))).toBe('next');
  });

});
