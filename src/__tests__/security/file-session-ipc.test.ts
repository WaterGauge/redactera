import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFileSession } from '../../main/sessionFiles';
import { createPathValidator } from '../../main/pathValidator';
import { registerCoreHandlers } from '../../main/ipcHandlers';
import { createFileLifecycle, finishFileShutdown } from '../../main/fileLifecycle';
import { DEFAULT_SETTINGS } from '../../types/settings';

type Handler = (...args: unknown[]) => unknown;
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function harness() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(process.env.CR008_TEST_TMPDIR ?? os.tmpdir(), 'ipc-session-')));
  roots.push(root);
  const session = createFileSession({ baseDirectory: path.join(root, 'private'),
    pidAlive: () => false, groupAlive: () => false });
  const original = path.join(root, 'original.pdf'), generated = path.join(session.directory, 'output.pdf'), destination = path.join(root, 'final.pdf');
  fs.writeFileSync(original, 'ORIGINAL'); fs.writeFileSync(generated, 'PROCESSED');
  const validators = createPathValidator(), lifecycle = createFileLifecycle(), handlers = new Map<string, Handler>();
  const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: destination }));
  const writeSettings = vi.fn();
  const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [original] }));
  const send = vi.fn(async () => ({ output_path: generated }));
  const frame = { url: 'file:///synthetic/index.html' };
  const sender = { mainFrame: frame, isDestroyed: () => false };
  const open = vi.fn(fs.promises.open.bind(fs.promises));
  const copyFile = vi.fn(fs.promises.copyFile.bind(fs.promises));
  registerCoreHandlers({
    app: { getPath: () => root }, session, trackWrite: lifecycle.trackWrite,
    ipcMain: lifecycle.wrap({ handle: (name: string, handler: Handler) => { handlers.set(name, handler); } } as never),
    dialog: { showOpenDialog, showSaveDialog },
    pageUrl: frame.url,
    mainWindowProvider: () => ({ isDestroyed: () => false, webContents: sender }), pathValidator: validators,
    settingsManager: { readSettings: () => DEFAULT_SETTINGS, writeSettings },
    pythonProcessManager: { send }, logger: { log: vi.fn(), initialize: vi.fn() },
    fsImpl: { ...fs, promises: { ...fs.promises, open, copyFile } },
  } as unknown as Parameters<typeof registerCoreHandlers>[0]);
  const call = async (name: string, ...args: unknown[]) => handlers.get(name)?.({ sender, senderFrame: frame }, ...args);
  return { root, session, original, generated, destination, validators, lifecycle, handlers, call, showSaveDialog, showOpenDialog, writeSettings, send, open, copyFile };
}

it('retains a completed PDF independently of Python EOF cleanup', async () => {
  const h = harness(); await h.call('dialog:openFile');
  const result = await h.call('pdf:process', { action: 'desensitize', payload: { file_path: h.original, keywords: ['SECRET'] } }) as { output_path: string };
  expect(result.output_path).not.toBe(h.generated);
  fs.unlinkSync(h.generated); // Closing an old worker must not delete the published result.
  expect(fs.readFileSync(result.output_path, 'utf8')).toBe('PROCESSED');
  expect(h.validators.isResolvedPathAllowed(result.output_path)).toBe(true);
  await h.call('dialog:saveFile'); await h.call('file:copy', result.output_path, h.destination);
  expect(fs.readFileSync(h.destination, 'utf8')).toBe('PROCESSED');
});

it('drains an actual retained-result copy before stopping its Python source owner', async () => {
  const h = harness(); await h.call('dialog:openFile');
  let finish!: () => void;
  h.copyFile.mockImplementationOnce((...args) => new Promise((resolve, reject) => {
    finish = () => { fs.promises.copyFile(...args).then(resolve, reject); };
  }));
  const processing = h.call('pdf:process', { action: 'desensitize', payload: { file_path: h.original, keywords: ['SECRET'] } });
  await vi.waitFor(() => expect(h.copyFile).toHaveBeenCalledOnce());
  const stop = vi.fn(async () => { fs.unlinkSync(h.generated); });
  const shutdown = finishFileShutdown({ lifecycle: h.lifecycle, closeWindows: vi.fn(), stopBackend: stop,
    cleanup: () => h.session.cleanup() });
  await Promise.resolve(); expect(stop).not.toHaveBeenCalled(); expect(fs.existsSync(h.generated)).toBe(true);
  finish(); await processing; await expect(shutdown).resolves.toBe(true);
  expect(stop).toHaveBeenCalledOnce(); expect(fs.readFileSync(h.original, 'utf8')).toBe('ORIGINAL');
});
it('places dragged originals in the owned root, not the global temporary directory', async () => {
  const h = harness(), saved = await h.call('file:saveDragged', { kind: 'bytes', fileName: 'test.pdf', bytes: new Uint8Array(Buffer.from('%PDF-1.7\nPRIVATE\n%%EOF')) }) as string;
  expect(saved.startsWith(h.session.directory + path.sep)).toBe(true);
  expect(fs.readFileSync(saved, 'utf8')).toBe('%PDF-1.7\nPRIVATE\n%%EOF');
  expect(h.session.cleanup()).toBe(true); expect(fs.existsSync(saved)).toBe(false);
});
it('uses the owned generation boundary for returned files', async () => {
  const h = harness(); await h.call('dialog:openFile');
  const result = await h.call('pdf:process', { action: 'desensitize', payload: { file_path: h.original, keywords: ['TARGET'] } }) as { output_path: string };
  expect(h.validators.isResolvedPathAllowed(result.output_path)).toBe(true);
  expect(h.validators.isResolvedPathAllowed(h.generated)).toBe(false);
  const outside = path.join(h.root, 'outside.pdf'); fs.writeFileSync(outside, 'PRIVATE');
  h.send.mockResolvedValueOnce({ output_path: outside });
  await expect(h.call('pdf:process', { action: 'desensitize', payload: { file_path: h.original, keywords: ['TARGET'] } })).rejects.toThrow();
  expect(h.validators.isResolvedPathAllowed(outside)).toBe(false);
});
it('refuses final exports inside session storage or an owned external staging directory', async () => {
  const h = harness(), staging = fs.mkdtempSync(path.join(h.root, '.pdf-desensitization-'));
  h.session.registerStaging(staging);
  for (const target of [path.join(h.session.directory, 'final.pdf'), path.join(staging, 'final.pdf')]) {
    h.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });
    await expect(h.call('dialog:saveFile', {})).rejects.toThrow('outside application temporary storage');
    expect(h.validators.claimWriteTarget(target)).toBeNull();
  }
});
it('waits for a physical export before stopping Python and removing the private input', async () => {
  const h = harness(); h.validators.addAllowedPath(h.generated);
  await h.call('dialog:saveFile', {});
  let finish!: () => void;
  h.open.mockImplementationOnce((...args) => new Promise((resolve, reject) => {
    finish = () => { fs.promises.open(...args).then(resolve, reject); };
  }));
  const writing = h.call('file:copy', h.generated, h.destination);
  await vi.waitFor(() => expect(h.open).toHaveBeenCalledOnce());
  const stop = vi.fn(async () => {
    expect(fs.existsSync(h.destination)).toBe(true);
    fs.unlinkSync(h.generated); // Models Python EOF cleanup.
  });
  const shutdown = finishFileShutdown({
    lifecycle: h.lifecycle, closeWindows: vi.fn(), stopBackend: stop,
    cleanup: () => h.session.cleanup(),
  });
  await Promise.resolve(); expect(stop).not.toHaveBeenCalled();
  expect(fs.existsSync(h.generated)).toBe(true);
  finish(); await writing; await expect(shutdown).resolves.toBe(true);
  expect(fs.readFileSync(h.destination, 'utf8')).toBe('PROCESSED');
  expect(fs.readFileSync(h.original, 'utf8')).toBe('ORIGINAL');
});
it('drains a late dragged write before session deletion', async () => {
  const h = harness(), fsWrite = vi.fn();
  h.handlers.clear();
  const ipc = h.lifecycle.wrap({ handle: (name: string, handler: Handler) => { h.handlers.set(name, handler); } } as never);
  let finish!: () => void;
  ipc.handle('file:saveDragged', () => new Promise<void>(resolve => {
    finish = () => { fsWrite(); fs.writeFileSync(path.join(h.session.directory, 'late.pdf'), 'PRIVATE'); resolve(); };
  }));
  const writing = h.call('file:saveDragged');
  const closing = finishFileShutdown({ lifecycle: h.lifecycle, closeWindows: vi.fn(), stopBackend: async () => undefined, cleanup: () => h.session.cleanup() });
  await Promise.resolve(); expect(fs.existsSync(h.session.directory)).toBe(true);
  finish(); await writing; await expect(closing).resolves.toBe(true);
  expect(fsWrite).toHaveBeenCalledOnce(); expect(fs.existsSync(h.session.directory)).toBe(false);
});


it('refuses managed log folders through both settings and the directory picker', async () => {
  const h = harness();
  await expect(h.call('settings:save', { ...DEFAULT_SETTINGS, log_folder_path: h.session.directory })).rejects.toThrow('temporary storage');
  h.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [h.session.directory] });
  await expect(h.call('select-log-folder')).rejects.toThrow('temporary storage');
  expect(h.writeSettings).not.toHaveBeenCalled();
  const logs = path.join(h.root, 'new-logs');
  await expect(h.call('settings:save', { ...DEFAULT_SETTINGS, log_folder_path: logs })).resolves.toEqual({ success: true });
});

it('drains the actual bounded-import output handle before deleting the session', async () => {
  const h = harness();
  let finish!: () => void;
  h.open.mockImplementationOnce((...args) => new Promise((resolve, reject) => {
    finish = () => { fs.promises.open(...args).then(resolve, reject); };
  }));
  const writing = h.call('file:saveDragged', {
    kind: 'bytes', fileName: 'test.pdf', bytes: new Uint8Array(Buffer.from('%PDF-1.7\\nPRIVATE\\n%%EOF')),
  });
  await vi.waitFor(() => expect(h.open).toHaveBeenCalledOnce());
  const stop = vi.fn(async () => undefined);
  const closing = finishFileShutdown({ lifecycle: h.lifecycle, closeWindows: vi.fn(),
    stopBackend: stop, cleanup: () => h.session.cleanup() });
  await Promise.resolve();
  expect(stop).not.toHaveBeenCalled();
  expect(fs.existsSync(h.session.directory)).toBe(true);
  finish();
  const saved = await writing as string;
  await expect(closing).resolves.toBe(true);
  expect(fs.existsSync(saved)).toBe(false);
  expect(fs.readFileSync(h.original, 'utf8')).toBe('ORIGINAL');
});
