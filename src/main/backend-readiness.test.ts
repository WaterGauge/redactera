import { EventEmitter } from 'events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPythonProcessManager } from './pythonProcessManager';
import { DEFAULT_SETTINGS } from '../types/settings';

const identity = { protocol: 1, appVersion: '1.2.1-beta.3', sourceSha256: 'a'.repeat(64) };
function harness() {
  const child = Object.assign(new EventEmitter(), { pid: 48012, stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn<(chunk: string | Buffer) => boolean>(() => true), end: vi.fn(() => { child.emit('exit', 0); child.emit('close', 0); }) }) });
  const spawn = vi.fn(() => child), failed = vi.fn();
  const manager = createPythonProcessManager({ app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/temp' },
    logger: { log: vi.fn() }, readSettings: () => DEFAULT_SETTINGS, childProcessImpl: { spawn } as never,
    expectedContract: identity, startupTimeoutMs: 100, onFailedToStart: failed });
  manager.start();
  const emit = (value: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
  return { manager, child, spawn, failed, emit };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('withholds documents until the actual worker proves its build identity', async () => {
  const h = harness(), request = h.manager.send('upload', { file_path: '/synthetic.pdf' });
  expect(h.child.stdin.write).not.toHaveBeenCalled();
  h.emit({ type: 'result', requestId: 'forged', success: true, data: 'premature' });
  await expect(h.manager.send('upload', {})).rejects.toThrow('busy');
  await vi.advanceTimersByTimeAsync(50);
  h.emit({ type: 'ready', ...identity });
  expect(h.child.stdin.write).toHaveBeenCalledOnce();
  const wire = JSON.parse(String(h.child.stdin.write.mock.calls[0]?.[0]));
  h.emit({ type: 'result', requestId: wire.requestId, generation: wire.generation, success: true, data: 'correct' });
  await expect(request).resolves.toBe('correct'); await h.manager.stop();
});

it.each([
  { ...identity, protocol: 0 }, { ...identity, appVersion: 'old-version' },
  { ...identity, sourceSha256: 'b'.repeat(64) }, { ...identity, sourceSha256: '' },
])('refuses an incompatible worker before it sees a document: %j', async mismatch => {
  const h = harness(), request = h.manager.send('upload', {}); request.catch(() => undefined);
  h.emit({ type: 'ready', ...mismatch });
  await expect(request).rejects.toThrow('版本不一致');
  expect(h.child.stdin.write).not.toHaveBeenCalled(); expect(h.child.stdin.end).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.spawn).toHaveBeenCalledOnce(); expect(h.failed).toHaveBeenCalledOnce();
  await expect(h.manager.send('upload', {})).rejects.toThrow('unavailable');
  await expect(h.manager.stop()).resolves.toEqual({ confirmed: true });
});

it('bounds missing startup acknowledgement and ignores a late ready event', async () => {
  const h = harness(), request = h.manager.send('upload', {}); request.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(100);
  await expect(request).rejects.toThrow('启动超时');
  h.emit({ type: 'ready', ...identity });
  expect(h.child.stdin.write).not.toHaveBeenCalled(); expect(h.spawn).toHaveBeenCalledOnce();
  await h.manager.stop();
});

it('uses the explicit source interpreter without a shell', async () => {
  vi.stubEnv('PDF_DESENSITIZATION_PYTHON', '/test/python');
  const h = harness();
  expect(h.spawn).toHaveBeenCalledWith('/test/python', [expect.stringContaining('main.py')], expect.not.objectContaining({ shell: true }));
  await h.manager.stop();
});
