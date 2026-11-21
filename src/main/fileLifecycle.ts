import type { IpcMain } from 'electron';
import { diagnosticErrorKind } from './diagnostics';

const OWNED = new Set(['dialog:openFile', 'dialog:saveFile', 'pdf:process', 'pdf:cancel', 'pdf:readPreview', 'file:copy', 'file:saveDragged']);
const WRITES = new Set(['file:copy', 'file:saveDragged']);

export function createFileLifecycle() {
  let closing = false;
  const pending = new Set<Promise<unknown>>();
  const writes = new Set<Promise<unknown>>();
  const drain = async (tasks: Set<Promise<unknown>>): Promise<void> => {
    while (tasks.size) await Promise.allSettled([...tasks]);
  };
  return {
    get closing(): boolean { return closing; },
    beginShutdown(): void { closing = true; },
    drainWrites: () => drain(writes),
    drainAll: () => drain(pending),
    trackWrite<T>(write: () => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(new Error('Application is shutting down'));
      const task = Promise.resolve().then(write);
      writes.add(task); pending.add(task);
      return task.then(value => { writes.delete(task); pending.delete(task); return value; }, error => {
        writes.delete(task); pending.delete(task); throw error;
      });
    },
    wrap(ipcMain: Pick<IpcMain, 'handle'>): Pick<IpcMain, 'handle'> {
      return { handle(channel, handler): void {
        if (!OWNED.has(channel)) { ipcMain.handle(channel, handler); return; }
        ipcMain.handle(channel, (event, ...args) => {
          if (closing) throw new Error('Application is shutting down');
          const task = Promise.resolve(handler(event, ...args));
          pending.add(task);
          if (WRITES.has(channel)) writes.add(task);
          return task.then(value => { pending.delete(task); writes.delete(task); return value; },
            error => { pending.delete(task); writes.delete(task); throw error; });
        });
      } };
    },
  };
}

export async function finishFileShutdown(options: {
  lifecycle: ReturnType<typeof createFileLifecycle>;
  closeWindows: () => void;
  stopBackend: () => Promise<unknown>;
  cleanup: () => boolean;
}): Promise<boolean> {
  options.lifecycle.beginShutdown();
  options.closeWindows();
  await options.lifecycle.drainWrites();
  await options.stopBackend();
  await options.lifecycle.drainAll();
  return options.cleanup();
}


export function installFileShutdown(options: {
  app: Pick<import('electron').App, 'on' | 'quit'>;
  lifecycle: ReturnType<typeof createFileLifecycle>;
  closeWindows: () => void;
  stopBackend: () => Promise<unknown>;
  cleanup: () => boolean;
  logger: { log(message: string, level?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'): void; cleanup(): void };
}): void {
  let started = false;
  let completed = false;
  options.app.on('before-quit', event => {
    if (completed) return;
    event.preventDefault();
    if (started) return;
    started = true;
    void finishFileShutdown(options).then(clean => {
      if (!clean) options.logger.log('Temporary session retained for safe recovery', 'WARN');
    }, error => {
      options.logger.log(`Shutdown did not confirm cleanup: ${diagnosticErrorKind(error)}`, 'WARN');
    }).finally(() => {
      try { options.logger.cleanup(); }
      catch { console.error('Failed to close application log'); }
      completed = true;
      options.app.quit();
    });
  });
}
