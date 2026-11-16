import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPythonProcessManager } from './pythonProcessManager';
import { DEFAULT_SETTINGS } from '../types/settings';
import { readyBackendOutput } from '../__tests__/backendFixture';

function child(pid: number) {
  const value = Object.assign(new EventEmitter(), {
    pid, stdout: readyBackendOutput(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn<(chunk: string | Buffer) => boolean>(() => true), end: vi.fn() }),
  });
  return value;
}
function harness(responseLimits?: { frameBytes: number; responseBytes: number }) {
  const children = [child(41001), child(41002), child(41003)];
  const spawn = vi.fn().mockImplementation(() => children[spawn.mock.calls.length - 1]);
  const terminated = vi.fn(async () => true), confirmed = vi.fn(async () => true);
  const manager = createPythonProcessManager({
    app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/tmp' },
    logger: { log: vi.fn() }, readSettings: () => DEFAULT_SETTINGS,
    childProcessImpl: { spawn } as never, terminateTree: terminated, confirmTreeStopped: confirmed,
    requestTimeoutMs: 1000, responseLimits,
  });
  manager.start();
  const message = (index = 0) => JSON.parse(String(children[index].stdin.write.mock.calls[0]?.[0]));
  const emit = (data: unknown, index = 0) => children[index].stdout.emit('data', Buffer.from(JSON.stringify(data) + '\n'));
  const close = (index = 0, code = 0) => { children[index].emit('exit', code); children[index].emit('close', code); };
  const send = () => { const work = manager.send('desensitize', {}); work.catch(() => undefined); return work; };
  return { manager, children, spawn, terminated, confirmed, message, emit, close, send };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T16:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('CR-016 request ownership, progress and confirmed cancellation', () => {
  it('sends one absolute budget and a distinct generation with each request', () => {
    const h = harness(); h.send();
    expect(h.message()).toMatchObject({ deadlineMs: Date.now() + 1000, generation: expect.any(String) });
  });
  it('rejects a second request before writing it to the busy worker', async () => {
    const h = harness(); h.send();
    await expect(h.manager.send('export', {})).rejects.toThrow(/busy/i);
    expect(h.children[0].stdin.write).toHaveBeenCalledOnce();
  });
  it('delivers progress without settling the request and keeps the original deadline', async () => {
    const h = harness(), progress = vi.fn(), settled = vi.fn();
    const work = h.manager.send('desensitize', {}, { onProgress: progress }); work.then(settled, settled);
    const wire = h.message();
    h.emit({ ...wire, type: 'progress', stage: 'ocr', message: 'waiting', elapsedMs: 20 });
    await Promise.resolve();
    expect(progress).toHaveBeenCalledOnce(); expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    h.emit({ ...wire, type: 'progress', stage: 'redacting', message: 'page 1', elapsedMs: 999, completed: 0, total: 2 });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.children[0].stdin.end).toHaveBeenCalledOnce(); expect(settled).not.toHaveBeenCalled();
    h.close(); await expect(work).rejects.toThrow(/timeout/i);
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });
  it('delivers output validation as progress while retaining generation and terminal-result checks', async () => {
    const h = harness(), progress = vi.fn(), settled = vi.fn();
    const work = h.manager.send('desensitize', {}, { onProgress: progress });
    work.then(settled, settled);
    const wire = h.message();
    h.emit({ ...wire, type: 'progress', stage: 'validating', message: '正在检查输出文件…', elapsedMs: 15 });
    h.emit({ ...wire, type: 'progress', stage: 'unknown-stage', message: 'untrusted', elapsedMs: 16 });
    h.emit({ ...wire, generation: 'old', type: 'progress', stage: 'validating', message: 'late', elapsedMs: 17 });
    await Promise.resolve();
    expect(progress).toHaveBeenCalledExactlyOnceWith({
      stage: 'validating', message: '正在检查输出文件…', elapsedMs: 15,
    });
    expect(settled).not.toHaveBeenCalled();
    h.emit({ ...wire, type: 'result', success: true, data: 'verified' });
    await expect(work).resolves.toBe('verified');
  });
  it.each([
    { type: 'progress', stage: 'ocr', message: 'wrong generation', generation: 'old' },
    { type: 'future', success: true, data: 'not a terminal' },
    { type: 'progress', stage: 'ocr', message: 42 },
    { type: 'result', success: 'yes', data: 'not boolean' },
  ])('ignores malformed or foreign nonterminal messages: %j', async extra => {
    const h = harness(), progress = vi.fn(), settled = vi.fn();
    const work = h.manager.send('desensitize', {}, { onProgress: progress }); work.then(settled, settled);
    const wire = h.message(); h.emit({ ...wire, ...extra }); await Promise.resolve();
    expect(settled).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled();
    h.emit({ ...wire, type: 'result', success: true, data: 'correct' });
    await expect(work).resolves.toBe('correct');
  });
  it('retains compatibility with an untyped boolean terminal from the current worker', async () => {
    const h = harness(), work = h.send();
    h.emit({ requestId: h.message().requestId, success: true, data: 'legacy' });
    await expect(work).resolves.toBe('legacy');
  });
  it('does not resolve a cancellation or accept new work before actual process closure', async () => {
    const h = harness(), work = h.send(), settled = vi.fn(); work.then(settled, settled);
    const cancel = h.manager.cancel();
    expect(h.manager.cancel()).toBe(cancel);
    await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    await expect(h.manager.send('upload', {})).rejects.toThrow(/stopping/i);
    expect(h.spawn).toHaveBeenCalledOnce();
    h.emit({ ...h.message(), type: 'result', success: true, data: 'late' });
    h.close(); await expect(cancel).resolves.toEqual({ confirmed: true });
    await expect(work).rejects.toThrow(/cancelled/i);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    const next = h.send(); h.emit({ ...h.message(1), type: 'result', success: true, data: 'new' }, 1);
    await expect(next).resolves.toBe('new');
  });
  it('forces only the owned tree after grace and waits for confirmation', async () => {
    const h = harness(), work = h.send(), cancel = h.manager.cancel();
    await vi.advanceTimersByTimeAsync(4999); expect(h.terminated).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(h.terminated).toHaveBeenCalledWith(41001);
    h.close(0, 1); await expect(cancel).resolves.toEqual({ confirmed: true });
    await expect(work).rejects.toThrow(/cancelled/i); expect(h.confirmed).toHaveBeenCalledWith(41001);
  });
  it('stays unavailable and preserves ownership when a live worker cannot be stopped', async () => {
    const h = harness(); h.terminated.mockResolvedValue(false);
    const work = h.send(), cancel = h.manager.cancel();
    await vi.advanceTimersByTimeAsync(7000);
    await expect(cancel).resolves.toEqual({ confirmed: false });
    await expect(work).rejects.toThrow(/confirm/i);
    await expect(h.manager.send('upload', {})).rejects.toThrow(/unavailable|stopping/i);
    h.manager.start(); expect(h.spawn).toHaveBeenCalledOnce();
  });
  it('ignores forged data and late close from an old generation after recovery', async () => {
    const h = harness(), first = h.send(), cancel = h.manager.cancel(); h.close(); await cancel; await expect(first).rejects.toThrow();
    const second = h.send(), wire = h.message(1);
    h.emit({ ...wire, type: 'result', success: true, data: 'forged' }); h.close();
    h.emit({ ...wire, type: 'result', success: true, data: 'correct' }, 1);
    await expect(second).resolves.toBe('correct'); expect(h.spawn).toHaveBeenCalledTimes(2);
  });
  it('joins an in-progress cancellation during application shutdown without restarting', async () => {
    const h = harness(), work = h.send(), cancel = h.manager.cancel();
    const stop = h.manager.stop(); h.close();
    await expect(stop).resolves.toEqual({ confirmed: true }); await cancel; await expect(work).rejects.toThrow();
    expect(h.spawn).toHaveBeenCalledOnce();
  });
  it('does not terminate an idle worker just because cancellation arrived after success', async () => {
    const h = harness(), work = h.send(); h.emit({ ...h.message(), type: 'result', success: true, data: 'done' });
    await work; await expect(h.manager.cancel()).resolves.toEqual({ confirmed: true });
    expect(h.children[0].stdin.end).not.toHaveBeenCalled(); expect(h.spawn).toHaveBeenCalledOnce();
  });
});


describe('backend IPC byte limits and recovery', () => {
  const limits = { frameBytes: 512, responseBytes: 1024 };
  it('preserves split multibyte terminal data and accepts the following request', async () => {
    const h = harness(limits), work = h.send();
    const payload = Buffer.from(JSON.stringify({ ...h.message(), type: 'result', success: true, data: '中文😀' }) + '\n');
    for (const byte of payload) h.children[0].stdout.emit('data', Buffer.from([byte]));
    await expect(work).resolves.toBe('中文😀');
    const next = h.send();
    const wire = JSON.parse(String(h.children[0].stdin.write.mock.calls[1]?.[0]));
    h.emit({ ...wire, type: 'result', success: true, data: 'next' });
    await expect(next).resolves.toBe('next');
  });
  it.each(['partial', 'complete', 'aggregate', 'invalid UTF-8', 'invalid JSON'])('retires on %s violation and rejects a following same-chunk terminal', async kind => {
    const h = harness(limits), work = h.send(), settled = vi.fn(); work.then(settled, settled);
    const terminal = Buffer.from(JSON.stringify({ ...h.message(), type: 'result', success: true, data: 'must not succeed' }) + '\n');
    if (kind === 'partial') {
      h.children[0].stdout.emit('data', Buffer.alloc(512, 97));
      h.children[0].stdout.emit('data', Buffer.from('a'));
    } else if (kind === 'aggregate') {
      h.children[0].stdout.emit('data', Buffer.from('\n'.repeat(1024)));
      h.children[0].stdout.emit('data', terminal);
    } else {
      h.children[0].stdout.emit('data', Buffer.concat([kind === 'complete' ? Buffer.from('a'.repeat(513) + '\n') : kind === 'invalid JSON' ? Buffer.from('{\n') : Buffer.from([0xff, 0x0a]), terminal]));
    }
    expect(h.children[0].stdin.end).toHaveBeenCalledOnce();
    await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    h.children[0].stdout.emit('data', terminal);
    await expect(h.manager.send('upload', {})).rejects.toThrow(/stopping/i);
    h.close(); await expect(work).rejects.toThrow(kind === 'invalid UTF-8' ? /invalid UTF-8/ : kind === 'invalid JSON' ? /invalid JSON/ : /IPC byte limit/);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    const next = h.send(); h.emit({ ...h.message(1), type: 'result', success: true, data: 'recovered' }, 1);
    await expect(next).resolves.toBe('recovered');
  });
  it('stays unavailable if an over-limit generation cannot be confirmed stopped', async () => {
    const h = harness(limits); h.terminated.mockResolvedValue(false);
    const work = h.send(); h.children[0].stdout.emit('data', Buffer.alloc(513, 97));
    await vi.advanceTimersByTimeAsync(7000);
    await expect(work).rejects.toThrow(/confirm/i); expect(h.spawn).toHaveBeenCalledOnce();
    await expect(h.manager.send('upload', {})).rejects.toThrow(/unavailable|stopping/i);
  });
});
