import { EventEmitter } from 'events';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPythonProcessManager } from './pythonProcessManager';
import { DEFAULT_SETTINGS, type AppSettings } from '../types/settings';
import { readyBackendOutput } from '../__tests__/backendFixture';
import { backendStartupFailure } from '../utils/backendStartupFailure';

type FakePythonProcess = EventEmitter & {
  pid: number | undefined;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};

function createFakePythonProcess(
  writeImpl?: (chunk: string | Buffer, callback?: (error?: Error | null) => void) => void
): FakePythonProcess {
  const process = new EventEmitter() as FakePythonProcess;
  process.pid = 4242;
  process.stdout = readyBackendOutput();
  process.stderr = new EventEmitter();
  process.stdin = Object.assign(new EventEmitter(), {
    end: vi.fn(() => { process.emit('exit', 0, null); process.emit('close', 0, null); }),
    write: vi.fn((chunk: string | Buffer, callback?: (error?: Error | null) => void) => {
      if (writeImpl) {
        writeImpl(chunk, callback);
      } else {
        callback?.(null);
      }
      return true;
    }),
  });
  process.kill = vi.fn();
  return process;
}

function createValidSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}

function decodeWrittenMessage(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString('utf-8') : value;
}

describe('pythonProcessManager', () => {
  beforeEach(() => {
    vi.stubEnv('PDF_DESENSITIZATION_PYTHON', undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('spawns python with dev logging settings in unpackaged mode', () => {
    const fakeProcess = createFakePythonProcess();
    const spawn = vi.fn(() => fakeProcess);
    const logger = { log: vi.fn() };
    const expectedScriptPath = path.join('/app/root', 'python-backend', 'main.py');
    const expectedLogFilePath = path.join('/logs', 'python_log_2026-03-31T00-00-00.txt');

    const manager = createPythonProcessManager({
      app: {
        isPackaged: false,
        getPath: vi.fn(() => '/app/temp'),
        getAppPath: vi.fn(() => '/app/root'),
      } as any,
      logger,
      readSettings: vi.fn(() =>
        createValidSettings({ developer_mode: true, log_folder_path: '/logs' })
      ),
      childProcessImpl: { spawn } as any,
      fsImpl: { existsSync: vi.fn(() => true) } as any,
    });

    manager.start();

    expect(spawn).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'python' : 'python3',
      [expectedScriptPath],
      expect.objectContaining({
        cwd: '/app/root',
        env: expect.objectContaining({
          TMPDIR: '/app/temp', TEMP: '/app/temp', TMP: '/app/temp',
          LOG_ENABLED: '1',
          LOG_FILE_PATH: expectedLogFilePath,
        }),
      })
    );
    expect(logger.log).toHaveBeenCalledWith(
      '[Python] launch mode: source',
      'DEBUG'
    );
    expect(logger.log).toHaveBeenCalledWith('[Python] script exists: true', 'DEBUG');
  });

  it('rejects send when python process is not running', async () => {
    const manager = createPythonProcessManager({
      app: {
        isPackaged: false,
        getPath: vi.fn(() => '/app/temp'),
        getAppPath: vi.fn(() => '/app/root'),
      } as any,
      logger: { log: vi.fn() },
      readSettings: vi.fn(() => createValidSettings()),
      childProcessImpl: { spawn: vi.fn() } as any,
    });

    await expect(manager.send('pdf:process', {})).rejects.toThrow('Python process is not running');
  });

  it('writes requests and resolves/rejects based on stdout responses', async () => {
    const fakeProcess = createFakePythonProcess();
    const manager = createPythonProcessManager({
      app: {
        isPackaged: false,
        getPath: vi.fn(() => '/app/temp'),
        getAppPath: vi.fn(() => '/app/root'),
      } as any,
      logger: { log: vi.fn() },
      readSettings: vi.fn(() => createValidSettings()),
      childProcessImpl: { spawn: vi.fn(() => fakeProcess) } as any,
    });

    manager.start();

    const successPromise = manager.send('mask', { page: 1 });
    const sentSuccessMessage = decodeWrittenMessage(
      fakeProcess.stdin.write.mock.calls[0]?.[0] as string | Buffer
    );
    const { requestId: successRequestId } = JSON.parse(sentSuccessMessage.trim()) as { requestId: string };
    fakeProcess.stdout.emit(
      'data',
      Buffer.from(`${JSON.stringify({ requestId: successRequestId, success: true, data: { ok: true } })}\n`)
    );

    await expect(successPromise).resolves.toEqual({ ok: true });

    const failurePromise = manager.send('mask', { page: 2 });
    const sentFailureMessage = decodeWrittenMessage(
      fakeProcess.stdin.write.mock.calls[1]?.[0] as string | Buffer
    );
    const { requestId: failureRequestId } = JSON.parse(sentFailureMessage.trim()) as {
      requestId: string;
    };
    fakeProcess.stdout.emit(
      'data',
      Buffer.from(`${JSON.stringify({ requestId: failureRequestId, success: false, error: 'bad payload' })}\n`)
    );

    await expect(failurePromise).rejects.toThrow('bad payload');
  });

  it('rejects send on stdin write error and request timeout', async () => {
    const writeErrorProcess = createFakePythonProcess((_chunk, callback) => {
      callback?.(new Error('broken pipe'));
    });
    const timeoutProcess = createFakePythonProcess();
    const managerWriteError = createPythonProcessManager({
      app: {
        isPackaged: false,
        getPath: vi.fn(() => '/app/temp'),
        getAppPath: vi.fn(() => '/app/root'),
      } as any,
      logger: { log: vi.fn() },
      readSettings: vi.fn(() => createValidSettings()),
      childProcessImpl: { spawn: vi.fn(() => writeErrorProcess) } as any,
    });

    managerWriteError.start();
    await expect(managerWriteError.send('mask', {})).rejects.toThrow('broken pipe');

    const managerTimeout = createPythonProcessManager({
      app: {
        isPackaged: false,
        getPath: vi.fn(() => '/app/temp'),
        getAppPath: vi.fn(() => '/app/root'),
      } as any,
      logger: { log: vi.fn() },
      readSettings: vi.fn(() => createValidSettings()),
      childProcessImpl: { spawn: vi.fn(() => timeoutProcess) } as any,
    });

    managerTimeout.start();
    const timeoutPromise = managerTimeout.send('mask', {});
    timeoutPromise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await expect(timeoutPromise).rejects.toThrow('Request timeout after 900000ms');
  });

  it('rejects pending requests and waits for EOF cleanup on stop', async () => {
    const fakeProcess = createFakePythonProcess();
    const manager = createPythonProcessManager({
      app: {
        isPackaged: false,
        getPath: vi.fn(() => '/app/temp'),
        getAppPath: vi.fn(() => '/app/root'),
      } as any,
      logger: { log: vi.fn() },
      readSettings: vi.fn(() => createValidSettings()),
      childProcessImpl: { spawn: vi.fn(() => fakeProcess) } as any,
    });

    manager.start();
    const pending = manager.send('mask', { page: 3 });
    const stopping = manager.stop();

    await expect(pending).rejects.toThrow('Python process stopped');
    await expect(stopping).resolves.toEqual({ confirmed: true });
    expect(fakeProcess.stdin.end).toHaveBeenCalledOnce();
    expect(fakeProcess.kill).not.toHaveBeenCalled();
  });

  it('notifies crash handlers and schedules restart attempts', async () => {
    const firstProcess = createFakePythonProcess();
    const secondProcess = createFakePythonProcess();
    const spawn = vi.fn()
      .mockImplementationOnce(() => firstProcess)
      .mockImplementationOnce(() => secondProcess);
    const onProcessCrashed = vi.fn();
    const onFailedToStart = vi.fn();

    const manager = createPythonProcessManager({
      app: {
        isPackaged: false,
        getPath: vi.fn(() => '/app/temp'),
        getAppPath: vi.fn(() => '/app/root'),
      } as any,
      logger: { log: vi.fn() },
      readSettings: vi.fn(() => createValidSettings()),
      childProcessImpl: { spawn } as any,
      onProcessCrashed,
      onFailedToStart,
    });

    manager.start();
    firstProcess.emit('exit', 1);
    firstProcess.emit('close', 1);
    expect(onProcessCrashed).toHaveBeenCalledWith({ code: 1 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(spawn).toHaveBeenCalledTimes(2);

    secondProcess.pid = undefined;
    secondProcess.emit('error', new Error('spawn fail'));
    expect(onFailedToStart).toHaveBeenCalledWith({ error: 'spawn fail' });
  });
  it.each([0xc0000135, -1073741515, 0xc000007b, -1073741701, 0xc000012f, -1073741521])(
    'reports loader failure %s before readiness without retrying or sending input', async code => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      if (!descriptor) throw new Error('Missing process platform descriptor');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const child = createFakePythonProcess();
        child.stdout = new EventEmitter();
        const spawn = vi.fn(() => child);
        const onProcessCrashed = vi.fn();
        const manager = createPythonProcessManager({
          app: { isPackaged: false, getPath: () => '/temp', getAppPath: () => '/app' },
          logger: { log: vi.fn() }, readSettings: () => createValidSettings(),
          childProcessImpl: { spawn: spawn as unknown as typeof import('child_process').spawn }, onProcessCrashed,
        });
        manager.start();
        const request = manager.send('pdf:process', {});
        const rejected = expect(request).rejects.toThrow(backendStartupFailure(code));
        child.emit('exit', code); child.emit('close', code);
        await rejected;
        await expect(manager.send('pdf:process', {})).rejects.toThrow(backendStartupFailure(code));
        await vi.advanceTimersByTimeAsync(120000);
        expect(spawn).toHaveBeenCalledOnce();
        expect(child.stdin.write).not.toHaveBeenCalled();
        expect(onProcessCrashed).toHaveBeenCalledExactlyOnceWith({ code });
        await manager.stop();
      } finally { Object.defineProperty(process, 'platform', descriptor); }
    }
  );

  it.each([['darwin', false], ['win32', true]] as const)(
    'keeps ordinary crash recovery on %s after ready=%s', async (platform, ready) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      if (!descriptor) throw new Error('Missing process platform descriptor');
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      try {
        const child = createFakePythonProcess();
        if (!ready) child.stdout = new EventEmitter();
        const next = createFakePythonProcess();
        const spawn = vi.fn().mockReturnValueOnce(child).mockReturnValue(next);
        const manager = createPythonProcessManager({
          app: { isPackaged: false, getPath: () => '/temp', getAppPath: () => '/app' },
          logger: { log: vi.fn() }, readSettings: () => createValidSettings(),
          childProcessImpl: { spawn: spawn as unknown as typeof import('child_process').spawn },
        });
        manager.start(); child.emit('exit', 0xc0000135); child.emit('close', 0xc0000135);
        await vi.advanceTimersByTimeAsync(1000);
        expect(spawn).toHaveBeenCalledTimes(2);
        await manager.stop();
      } finally { Object.defineProperty(process, 'platform', descriptor); }
    }
  );

});
