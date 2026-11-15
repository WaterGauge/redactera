import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCoreHandlers } from '../../main/ipcHandlers';
import { createPathValidator } from '../../main/pathValidator';
import { DEFAULT_SETTINGS } from '../../types/settings';

type Handler = (...args: unknown[]) => unknown;
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });

function harness() {
  // Match Main's asynchronous realpath, including Windows short names and macOS aliases.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(process.env.CR006_TEST_TMPDIR ?? os.tmpdir(), 'cr006-')));
  roots.push(root);
  const temp = path.join(root, 'temp');
  fs.mkdirSync(temp);
  const source = path.join(root, 'selected.pdf'), secret = path.join(root, 'unselected.pdf');
  const output = path.join(temp, 'result.pdf'), png = path.join(temp, 'page.png'), zip = path.join(temp, 'pages.zip');
  [source, secret, output, png, zip].forEach(file => fs.writeFileSync(file, 'synthetic:' + path.basename(file)));
  const validator = createPathValidator();
  validator.addAllowedPath(source);
  const handlers = new Map<string, Handler>();
  const send = vi.fn(async (action: string, payload: Record<string, unknown>) => {
    if (action === 'upload') return { pages: [{ page_num: 1, text: 'PUBLIC' }] };
    if (action === 'export') {
      if (payload.format === 'pdf') return { output_path: payload.file_path };
      if (payload.format === 'png') return { output_files: [png] };
      return { zip_path: zip };
    }
    return { output_path: output };
  });
  const showSaveDialog = vi.fn(async () => ({ canceled: true, filePath: undefined as string | undefined }));
  const cancel = vi.fn(async () => ({ confirmed: true }));
  const sender = { isDestroyed: () => false, send: vi.fn() };
  const log = vi.fn();
  registerCoreHandlers({
    ipcMain: { handle: (channel: string, listener: Handler) => { handlers.set(channel, listener); } },
    app: { getPath: () => temp },
    dialog: { showOpenDialog: vi.fn(), showSaveDialog },
    mainWindowProvider: () => ({ isDestroyed: () => false }),
    pathValidator: validator,
    pythonProcessManager: { send, cancel },
    settingsManager: { readSettings: () => DEFAULT_SETTINGS },
    logger: { log },
    fsImpl: fs,
  } as unknown as Parameters<typeof registerCoreHandlers>[0]);
  const call = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error('missing handler');
    return handler({ sender }, ...args);
  };
  const request = (action = 'desensitize', extra: Record<string, unknown> = {}) => ({
    action, payload: { file_path: source, ...(action === 'desensitize' ? { keywords: ['TARGET'], settings: DEFAULT_SETTINGS } : {}),
      ...(action === 'export' ? { format: 'pdf' } : {}), ...extra },
  });
  return { root, temp, source, secret, output, png, zip, validator, send, cancel, sender, handlers, call, request, showSaveDialog, log };
}

it('retains useful action logs without OCR credentials, keywords, URLs or complete paths', async () => {
  const h = harness();
  const settings = { ...DEFAULT_SETTINGS, paddle_token: 'SYNTHETIC_PADDLE', baidu_api_key: 'SYNTHETIC_API_KEY',
    baidu_secret_key: 'SYNTHETIC_SECRET', paddle_api_url: 'https://SYNTHETIC_URL.invalid' };
  await h.call('pdf:process', h.request('desensitize', { settings, keywords: ['SYNTHETIC_KEYWORD'] }));
  const logs = JSON.stringify(h.log.mock.calls);
  expect(logs).not.toContain('SYNTHETIC'); expect(logs).not.toContain(h.source);
  expect(logs).toContain('desensitize'); expect(logs).toContain('completed');
});

describe('CR-016 IPC operation ownership', () => {
  it.each([null, '', 1, 'a/b', 'a'.repeat(129)])('rejects an invalid operation identity: %j', async operationId => {
    const h = harness();
    await expect(h.call('pdf:process', { ...h.request(), operationId })).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });
  it('routes progress to the request owner and allows only that operation to cancel it', async () => {
    const h = harness(); let done!: (value: { output_path: string }) => void;
    h.send.mockReturnValueOnce(new Promise(resolve => { done = resolve; }));
    const work = h.call('pdf:process', { ...h.request(), operationId: 'ui-123' });
    work.catch(() => undefined);
    const options = (h.send.mock.calls[0] as unknown[])[2] as { onProgress: (data: unknown) => void };
    options.onProgress({ stage: 'ocr', message: 'waiting', elapsedMs: 10 });
    expect(h.sender.send).toHaveBeenCalledWith('pdf:progress', expect.objectContaining({ operationId: 'ui-123', message: 'waiting' }));
    await expect(h.call('pdf:cancel', 'old-operation')).resolves.toEqual({ confirmed: false });
    const foreign = h.handlers.get('pdf:cancel');
    if (!foreign) throw new Error('missing cancel handler');
    await expect(foreign({ sender: { isDestroyed: () => false } }, 'ui-123')).resolves.toEqual({ confirmed: false });
    expect(h.cancel).not.toHaveBeenCalled();
    const cancellation = h.call('pdf:cancel', 'ui-123');
    expect(h.cancel).toHaveBeenCalledOnce(); done({ output_path: h.output }); await expect(work).rejects.toThrow('cancelled');
    await expect(cancellation).resolves.toEqual({ confirmed: true });
    options.onProgress({ stage: 'ocr', message: 'late', elapsedMs: 20 });
    expect(h.sender.send).toHaveBeenCalledOnce();
  });
});

describe('processing authorization through real Main handlers and filesystem', () => {
  it.each(['png', 'png_zip', 'pdf'])('forwards only supported explicit DPI for %s', async format => {
    for (const dpi of [150, 200, 300]) {
      const h = harness();
      await h.call('pdf:process', h.request('export', { format, dpi }));
      expect(h.send).toHaveBeenCalledWith('export', { file_path: h.source, format, dpi });
    }
  });

  it.each([0, 149, 600, true, '300', null, NaN, Infinity])('rejects invalid DPI before dispatch: %j', async dpi => {
    const h = harness();
    await expect(h.call('pdf:process', h.request('export', { format: 'png_zip', dpi }))).rejects.toThrow('DPI');
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(['upload', 'desensitize', 'export'])('rejects an unselected source for %s before dispatch or new grants', async action => {
    const h = harness();
    await expect(h.call('pdf:process', h.request(action, { file_path: h.secret }))).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.validator.isResolvedPathAllowed(h.secret)).toBe(false);
    await expect(h.call('pdf:readFile', h.secret)).rejects.toThrow('Access denied');
  });

  it.each([null, [], {}, { action: 'scan', payload: {} }, { action: 1, payload: {} },
    { action: 'upload', payload: [] }, { action: 'upload', payload: null },
    { action: 'upload', payload: { file_path: { path: '/private.pdf' } } },
  ].map(value => [value]))('rejects malformed requests without backend dispatch: %j', async request => {
    const h = harness();
    await expect(h.call('pdf:process', request)).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(['pdf', 'png', 'png_zip'])('rejects renderer-chosen save_path in %s requests before writing', async format => {
    const h = harness();
    const before = fs.readFileSync(h.secret);
    await expect(h.call('pdf:process', h.request('export', { format, save_path: h.secret }))).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
    expect(fs.readFileSync(h.secret)).toEqual(before);
  });

  it.each(['output_path', 'filePath', 'nested'])('rejects unexpected payload path forms: %s', async key => {
    const h = harness();
    await expect(h.call('pdf:process', h.request('upload', { [key]: h.secret }))).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each([[], [''], [42], 'TARGET'].map(value => [value]))('rejects malformed keyword lists: %j', async keywords => {
    const h = harness();
    await expect(h.call('pdf:process', h.request('desensitize', { keywords }))).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('forwards the authorized normalized source instead of the unnormalized caller value', async () => {
    const h = harness();
    const alias = path.join(h.root, 'sub') + '/../selected.pdf';
    await h.call('pdf:process', h.request('upload', { file_path: alias }));
    expect(h.send).toHaveBeenCalledWith('upload', { file_path: h.source });
  });

  it('preserves a legitimate filename ending in a space in both grant and use', async () => {
    const h = harness(), spaced = h.source + ' ';
    fs.writeFileSync(spaced, 'separate selected file');
    h.validator.addAllowedPath(spaced);
    await h.call('pdf:process', h.request('upload', { file_path: spaced }));
    expect(h.send).toHaveBeenCalledWith('upload', { file_path: spaced });
    expect(await h.call('pdf:readFile', spaced)).toBe(fs.readFileSync(spaced, 'base64'));
  });

  it('does not grant arbitrary nested response paths from upload', async () => {
    const h = harness();
    h.send.mockResolvedValueOnce({ pages: [], nested: { reportPath: h.secret } } as never);
    await h.call('pdf:process', h.request('upload'));
    expect(h.validator.isResolvedPathAllowed(h.secret)).toBe(false);
  });

  it('forwards mask review metadata without authorizing paths inside it', async () => {
    const h = harness();
    const review = { version: 1, pageCount: 1, regions: [], nested: { output_path: h.secret } };
    h.send.mockResolvedValueOnce({ output_path: h.output, review } as never);
    const result = await h.call('pdf:process', h.request()) as { review: unknown };
    expect(result.review).toEqual(review);
    expect(h.validator.isResolvedPathAllowed(h.secret)).toBe(false);
    await expect(h.call('pdf:readFile', h.secret)).rejects.toThrow('Access denied');
  });

  it('requires PDF export to return its already-authorized source', async () => {
    const h = harness();
    h.send.mockResolvedValueOnce({ output_path: h.secret });
    await expect(h.call('pdf:process', h.request('export'))).rejects.toThrow();
    expect(h.validator.isResolvedPathAllowed(h.secret)).toBe(false);
  });

  for (const kind of ['outside', 'symlink', 'directory']) {
    it('rejects an unsafe generated result: ' + kind, async context => {
      const h = harness();
      let candidate = h.secret;
      if (kind === 'symlink') {
        candidate = path.join(h.temp, 'link.pdf');
        try { fs.symlinkSync(h.secret, candidate); }
        catch (error) {
          if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            context.skip();
            return;
          }
          throw error;
        }
      }
      if (kind === 'directory') candidate = h.temp;
      h.send.mockResolvedValueOnce({ output_path: candidate });
      await expect(h.call('pdf:process', h.request())).rejects.toThrow();
      expect(h.validator.isResolvedPathAllowed(candidate)).toBe(false);
      expect(h.validator.isResolvedPathAllowed(h.secret)).toBe(false);
    });

  }

  it('validates the entire PNG result list before granting any member', async () => {
    const h = harness();
    h.send.mockResolvedValueOnce({ output_files: [h.png, h.secret] } as never);
    await expect(h.call('pdf:process', h.request('export', { format: 'png' }))).rejects.toThrow();
    expect(h.validator.isResolvedPathAllowed(h.png)).toBe(false);
  });

  it.each([null, [], 'invalid'].map(value => [value]))('rejects invalid settings: %j', async settings => {
    const h = harness();
    await expect(h.call('pdf:process', h.request('desensitize', { settings }))).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(['PDF', 'zip', ''])('rejects unsupported formats: %s', async format => {
    const h = harness();
    await expect(h.call('pdf:process', h.request('export', { format }))).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each([null, [], 'invalid', {}, { output_path: 42 }, { output_path: 'relative.pdf' }].map(value => [value]))(
    'rejects invalid generated responses without any new grant: %j', async value => {
      const h = harness(), before = new Set(h.validator.allowedPaths);
      h.send.mockResolvedValueOnce(value as never);
      await expect(h.call('pdf:process', h.request())).rejects.toThrow();
      expect(h.validator.allowedPaths).toEqual(before);
    });

  it('rejects unexpected request-level fields', async () => {
    const h = harness();
    await expect(h.call('pdf:process', { ...h.request(), file_path: h.secret })).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('grants only the designated output of a successful processing response', async () => {
    const h = harness();
    h.send.mockResolvedValueOnce({ output_path: h.output, nested: { otherPath: h.secret } } as never);
    await h.call('pdf:process', h.request());
    expect(h.validator.isResolvedPathAllowed(h.output)).toBe(true);
    expect(h.validator.isResolvedPathAllowed(h.secret)).toBe(false);
  });

  it.each(['upload', 'desensitize', 'pdf', 'png', 'png_zip'])('keeps authorized %s processing and exact result access working', async mode => {
    const h = harness(), exporting = ['pdf', 'png', 'png_zip'].includes(mode);
    await h.call('pdf:process', h.request(exporting ? 'export' : mode, exporting ? { format: mode } : {}));
    expect(h.send).toHaveBeenCalledTimes(1);
    const file = mode === 'desensitize' ? h.output : mode === 'png' ? h.png : mode === 'png_zip' ? h.zip : h.source;
    expect(await h.call('pdf:readFile', file)).toBe(fs.readFileSync(file, 'base64'));
    expect(h.validator.isResolvedPathAllowed(h.secret)).toBe(false);
  });

  it('keeps Main copying byte-identical generated output and awaits physical completion', async () => {
    const h = harness(), destination = path.join(h.root, 'chosen.pdf');
    await h.call('pdf:process', h.request());
    h.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
    await h.call('dialog:saveFile', {});
    await expect(h.call('file:copy', h.output, destination)).resolves.toEqual({ success: true });
    expect(fs.readFileSync(destination)).toEqual(fs.readFileSync(h.output));
  });
});
