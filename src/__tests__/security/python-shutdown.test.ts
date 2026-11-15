import { EventEmitter } from 'events';
import childProcess from 'child_process';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPythonProcessManager } from '../../main/pythonProcessManager';
import { DEFAULT_SETTINGS } from '../../types/settings';
import { readyBackendOutput } from '../backendFixture';

beforeEach(() => vi.useFakeTimers());
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
if (!platformDescriptor) throw new Error('Missing platform descriptor');
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.useRealTimers();
});

function harness(nativeTreeControl = false) {
  const child = Object.assign(new EventEmitter(), {
    pid: 432123, exitCode: null as number | null, signalCode: null,
    stdin: Object.assign(new EventEmitter(), { write: vi.fn<(chunk: string | Buffer) => boolean>(() => true), end: vi.fn() }),
    stdout: readyBackendOutput(), stderr: new EventEmitter(), kill: vi.fn(() => true),
  });
  const terminateTree = vi.fn(async () => true);
  const spawn = vi.fn<(command: string, args: string[], options: childProcess.SpawnOptions) => typeof child>(() => child);
  const confirmTreeStopped = vi.fn(async () => true);
  const manager = createPythonProcessManager({
    app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/temp' },
    logger: { log: vi.fn() }, readSettings: () => DEFAULT_SETTINGS,
    childProcessImpl: { spawn },
    ...(nativeTreeControl ? {} : { terminateTree, confirmTreeStopped }),
  } as unknown as Parameters<typeof createPythonProcessManager>[0]);
  manager.start();
  const close = () => { child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); };
  return { child, manager, terminateTree, confirmTreeStopped, spawn, close };
}

it('requests EOF first and reports completion only after close', async () => {
  const h = harness(), stopping = h.manager.stop();
  expect(stopping).toBeInstanceOf(Promise);
  expect(h.child.stdin.end).toHaveBeenCalledOnce();
  expect(h.child.kill).not.toHaveBeenCalled();
  h.close();
  await expect(stopping).resolves.toEqual({ confirmed: true });
});

it('is idempotent and keeps shutdown pending through exit until stdio closes', async () => {
  const h = harness(), first = h.manager.stop(), second = h.manager.stop();
  expect(first).toBe(second);
  let finished = false; Promise.resolve(first).then(() => { finished = true; });
  h.child.emit('exit', 0, null);
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toBe(false);
  expect(h.child.stdin.end).toHaveBeenCalledOnce();
  h.child.emit('close', 0, null);
  await expect(first).resolves.toEqual({ confirmed: true });
});

it('escalates only after grace and still waits for physical process closure', async () => {
  const h = harness(), stopping = h.manager.stop();
  let finished = false; Promise.resolve(stopping).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(4999);
  expect(h.terminateTree).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.terminateTree).toHaveBeenCalledWith(h.child.pid);
  expect(finished).toBe(false);
  h.close();
  await expect(stopping).resolves.toEqual({ confirmed: true });
});


it('returns unconfirmed when termination does not establish physical closure', async () => {
  const h = harness(); h.terminateTree.mockResolvedValueOnce(false);
  const stopping = h.manager.stop();
  await vi.advanceTimersByTimeAsync(7000);
  await expect(stopping).resolves.toEqual({ confirmed: false });
  expect(h.confirmTreeStopped).not.toHaveBeenCalled();
});

it('does not target an old PID after exit while inherited stdio is still open', async () => {
  const h = harness(), stopping = h.manager.stop();
  h.child.emit('exit', 1, null);
  await vi.advanceTimersByTimeAsync(7000);
  await expect(stopping).resolves.toEqual({ confirmed: false });
  expect(h.terminateTree).not.toHaveBeenCalled();
});

it('rejects new requests after shutdown has begun', async () => {
  const h = harness(), stopping = h.manager.stop();
  await expect(h.manager.send('upload', {})).rejects.toThrow('stopped');
  h.close(); await stopping;
});

it('does not restart on a runtime error from a still-owned live child', async () => {
  const h = harness(); h.child.emit('error', new Error('kill failed'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.spawn).toHaveBeenCalledOnce();
  h.close();
});

it('handles asynchronous stdin failure during EOF without abandoning process closure', async () => {
  const h = harness(), stopping = h.manager.stop();
  expect(() => h.child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
  expect(h.terminateTree).not.toHaveBeenCalled();
  expect(h.spawn).toHaveBeenCalledOnce();
  h.close();
  await expect(stopping).resolves.toEqual({ confirmed: true });
});

it('uses only the owned PID and local taskkill tree flags after Windows grace', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  const h = harness(true);
  const taskkill = vi.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
    h.close(); (args[3] as (error: Error | null) => void)(null);
    return {};
  }) as never);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  const request = h.manager.send('upload', {}); request.catch(() => undefined);
  expect(Buffer.isBuffer(h.child.stdin.write.mock.calls[0][0])).toBe(true);
  const stopping = h.manager.stop();
  await expect(request).rejects.toThrow('stopped');
  await vi.advanceTimersByTimeAsync(4999); expect(taskkill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(stopping).resolves.toEqual({ confirmed: true });
  expect(taskkill).toHaveBeenCalledWith(path.join('C:\\Windows', 'System32', 'taskkill.exe'),
    ['/PID', String(h.child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, expect.any(Function));
  expect(kill).toHaveBeenCalledWith(h.child.pid, 0);
  expect(h.spawn.mock.calls[0][2]).toMatchObject({ detached: false, env: { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
});

it('keeps Windows shutdown unconfirmed when taskkill cannot stop the tree', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const h = harness(true);
  vi.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
    (args[3] as (error: Error) => void)(new Error('access denied'));
    return {};
  }) as never);
  const kill = vi.spyOn(process, 'kill');
  const stopping = h.manager.stop();
  await vi.advanceTimersByTimeAsync(7000);
  await expect(stopping).resolves.toEqual({ confirmed: false });
  expect(kill).not.toHaveBeenCalled();
});
