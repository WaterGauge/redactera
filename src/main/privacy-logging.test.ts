import { EventEmitter } from 'events';
import { afterEach, expect, it, vi } from 'vitest';
import { createPythonProcessManager } from './pythonProcessManager';
import { DEFAULT_SETTINGS } from '../types/settings';
import { diagnosticErrorKind } from './diagnostics';
import { readyBackendOutput } from '../__tests__/backendFixture';

const secret = 'SYNTHETIC_凭证_"token\\keyword\nDOC_CONTENT';
const privatePath = '/private/SYNTHETIC_DOCUMENT.pdf';
function harness() {
  const child = Object.assign(new EventEmitter(), { pid: 42020, stdout: readyBackendOutput(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), {
      write: vi.fn<(value: string | Buffer) => boolean>(() => true),
      end: vi.fn(() => { child.emit('exit', 0); child.emit('close', 0); }),
    }),
  });
  const log = vi.fn();
  const manager = createPythonProcessManager({ app: { isPackaged: false, getAppPath: () => privatePath, getPath: () => '/tmp' },
    logger: { log }, readSettings: () => DEFAULT_SETTINGS, childProcessImpl: { spawn: vi.fn(() => child) } as never });
  manager.start();
  const wire = () => JSON.parse(String(child.stdin.write.mock.calls.at(-1)?.[0]));
  const logs = () => JSON.stringify(log.mock.calls);
  const emit = (value: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
  return { manager, child, log, wire, logs, emit };
}
afterEach(() => { vi.restoreAllMocks(); });

it.each([undefined, null, 'SYNTHETIC_CODE', 'EPIPE_SYNTHETIC_CODE', 123])('does not serialize an unknown error code %j', code => {
  expect(diagnosticErrorKind(Object.assign(new Error(secret), { code }))).toBe('Error');
});
it('does not read error messages/stacks and handles throwing metadata accessors safely', () => {
  const read = vi.fn(() => { throw new Error(secret); });
  const error = Object.defineProperties({}, { message: { get: read }, stack: { get: read }, name: { get: read } });
  expect(diagnosticErrorKind(error)).toBe('unknown'); expect(read).not.toHaveBeenCalled();
  Object.defineProperty(error, 'code', { get: read });
  expect(diagnosticErrorKind(error)).toBe('unknown'); expect(read).toHaveBeenCalledOnce();
});

it('keeps the full result and progress on the protocol without copying them to logs', async () => {
  const h = harness(), progress = vi.fn();
  const work = h.manager.send('upload', { file_path: privatePath, token: secret }, { onProgress: progress });
  h.emit({ ...h.wire(), type: 'progress', stage: 'ocr', message: secret, elapsedMs: 1 });
  const data = { pages: [{ text: secret }], output_path: privatePath };
  const text = JSON.stringify({ ...h.wire(), type: 'result', success: true, data }) + '\n';
  const split = text.indexOf('SYNTHETIC') + 4;
  h.child.stdout.emit('data', Buffer.from(text.slice(0, split)));
  h.child.stdout.emit('data', Buffer.from(text.slice(split)));
  await expect(work).resolves.toEqual(data); expect(progress).toHaveBeenCalledWith(expect.objectContaining({ message: secret }));
  expect(h.logs()).not.toContain('SYNTHETIC'); expect(h.logs()).not.toContain(privatePath);
  expect(h.log).toHaveBeenCalled(); await h.manager.stop();
});
it('does not log malformed stdout or old-generation stderr, including split secrets', async () => {
  const h = harness();
  h.child.stdout.emit('data', Buffer.from('not-json SYNTHETIC_' + '\n'));
  h.child.stderr.emit('data', Buffer.from(secret.slice(0, 8))); h.child.stderr.emit('data', Buffer.from(secret.slice(8)));
  await h.manager.stop(); h.child.stderr.emit('data', Buffer.from(privatePath));
  expect(h.logs()).not.toContain('SYNTHETIC'); expect(h.logs()).not.toContain(privatePath);
  expect(h.log.mock.calls.some(args => args[1] === 'ERROR')).toBe(true);
});
it('preserves UI-facing error details while omitting them from diagnostic copies', async () => {
  const h = harness(), work = h.manager.send('mask', {});
  h.emit({ ...h.wire(), type: 'result', success: false, error: secret });
  await expect(work).rejects.toThrow(secret); expect(h.logs()).not.toContain('SYNTHETIC'); await h.manager.stop();
});
it('classifies stdin failures without formatting the original Error', async () => {
  const h = harness(), work = h.manager.send(secret, {}); work.catch(() => undefined);
  h.child.stdin.emit('error', Object.assign(new Error(secret + privatePath), { code: 'EPIPE' }));
  await expect(work).rejects.toThrow(secret); expect(h.logs()).not.toContain('SYNTHETIC');
  expect(h.logs()).toContain('EPIPE'); await h.manager.stop();
});
