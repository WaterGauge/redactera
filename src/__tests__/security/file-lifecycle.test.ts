import { expect, it, vi } from 'vitest';
import { createFileLifecycle, finishFileShutdown, installFileShutdown } from '../../main/fileLifecycle';

type Handler = (...args: unknown[]) => unknown;
function harness() {
  const lifecycle = createFileLifecycle(), handlers = new Map<string, Handler>();
  const ipc = lifecycle.wrap({ handle: (name: string, fn: Handler) => { handlers.set(name, fn); } } as never);
  return { lifecycle, handlers, ipc };
}
it('rejects newly arriving file work once shutdown begins', () => {
  const h = harness(), writer = vi.fn(); h.ipc.handle('file:copy', writer);
  h.lifecycle.beginShutdown();
  expect(() => h.handlers.get('file:copy')?.({})).toThrow('shutting down');
  expect(writer).not.toHaveBeenCalled();
});
it('drains actual writes before EOF, then pending processing before cleanup', async () => {
  const h = harness(), events: string[] = [];
  let finishWrite!: () => void, finishProcess!: () => void;
  h.ipc.handle('file:copy', () => new Promise<void>(resolve => { finishWrite = resolve; }));
  h.ipc.handle('pdf:process', () => new Promise<void>(resolve => { finishProcess = resolve; }));
  const write = h.handlers.get('file:copy')?.({}), work = h.handlers.get('pdf:process')?.({});
  const shutdown = finishFileShutdown({
    lifecycle: h.lifecycle, closeWindows: () => { events.push('windows'); },
    stopBackend: async () => { events.push('EOF'); finishProcess(); },
    cleanup: () => { events.push('cleanup'); return true; },
  });
  await Promise.resolve(); expect(events).toEqual(['windows']);
  finishWrite(); await write; await work; await shutdown;
  expect(events).toEqual(['windows', 'EOF', 'cleanup']);
});
it('waits for rejected write completion and does not retain rejected tasks', async () => {
  const h = harness(); let fail!: (error: Error) => void;
  h.ipc.handle('file:saveDragged', () => new Promise((_resolve, reject) => { fail = reject; }));
  const work = Promise.resolve(h.handlers.get('file:saveDragged')?.({})); work.catch(() => undefined);
  h.lifecycle.beginShutdown(); let done = false;
  const drain = h.lifecycle.drainWrites().then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  fail(new Error('disk failure')); await expect(work).rejects.toThrow('disk failure'); await drain;
  expect(done).toBe(true);
});
it('prevents recursive Electron quit until shutdown and logging are complete', async () => {
  const h = harness(); let beforeQuit!: (event: { preventDefault(): void }) => void;
  const events: string[] = [];
  const app = { on: (_name: string, fn: typeof beforeQuit) => { beforeQuit = fn; },
    quit: vi.fn(() => { events.push('quit'); beforeQuit({ preventDefault: vi.fn() }); }) };
  installFileShutdown({
    app: app as never, lifecycle: h.lifecycle,
    closeWindows: () => { events.push('windows'); beforeQuit({ preventDefault: vi.fn() }); },
    stopBackend: async () => { events.push('EOF'); },
    cleanup: () => { events.push('files'); return true; },
    logger: { log: vi.fn(), cleanup: () => { events.push('logger'); } },
  });
  const preventDefault = vi.fn(); beforeQuit({ preventDefault });
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(events).toEqual(['windows', 'EOF', 'files', 'logger', 'quit']);
});


it('continues Electron quit if closing the logger itself fails', async () => {
  const h = harness(); let beforeQuit!: (event: { preventDefault(): void }) => void;
  const app = { on: (_name: string, handler: typeof beforeQuit) => { beforeQuit = handler; }, quit: vi.fn() };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  installFileShutdown({ app: app as never, lifecycle: h.lifecycle, closeWindows: vi.fn(),
    stopBackend: async () => undefined, cleanup: () => true,
    logger: { log: vi.fn(), cleanup: () => { throw new Error('logger failed'); } } });
  beforeQuit({ preventDefault: vi.fn() });
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
  vi.restoreAllMocks();
});


it('waits for a pending asynchronous preview read before cleaning session files', async () => {
  const h = harness(); let finish!: () => void;
  h.ipc.handle('pdf:readPreview', () => new Promise<void>(resolve => { finish = resolve; }));
  const read = h.handlers.get('pdf:readPreview')?.({});
  const cleanup = vi.fn(() => true);
  const shutdown = finishFileShutdown({ lifecycle: h.lifecycle, closeWindows: vi.fn(), stopBackend: async () => undefined, cleanup });
  await Promise.resolve(); await Promise.resolve(); expect(cleanup).not.toHaveBeenCalled();
  expect(() => h.handlers.get('pdf:readPreview')?.({})).toThrow('shutting down');
  finish(); await read; await shutdown; expect(cleanup).toHaveBeenCalledOnce();
});
