import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import type { App } from 'electron';
import type { BackendLaunch } from './sessionFiles';
import type { AppSettings } from '../types/settings';
import { isProcessingStage, type ProcessingProgress } from '../types/processing';
import { diagnosticErrorKind } from './diagnostics';
import { backendStartupFailure } from '../utils/backendStartupFailure';
import { BACKEND_CONTRACT, type BackendContract } from './backendContract';
import { BackendFrames, type BackendFrameLimits } from './backendFrames';

const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const PYTHON_RESTART_BASE_DELAY_MS = 1000;
const PYTHON_RESTART_MAX_DELAY_MS = 30000;
const PYTHON_MAX_RESTART_ATTEMPTS = 5;
const PYTHON_STABLE_UPTIME_MS = 30000;

interface LoggerLike {
  log(message: string, level?: 'INFO' | 'ERROR' | 'WARN' | 'DEBUG'): void;
}

interface PythonProcessManagerDependencies {
  app: Pick<App, 'isPackaged' | 'getAppPath' | 'getPath'>;
  logger: LoggerLike;
  readSettings: () => AppSettings;
  prepareLaunch?: () => BackendLaunch;
  temporaryRoot?: () => string;
  terminateTree?: (pid: number) => Promise<boolean>;
  confirmTreeStopped?: (pid: number) => Promise<boolean>;
  onProcessCrashed?: (payload: { code: number | null }) => void;
  onFailedToStart?: (payload: { error: string }) => void;
  childProcessImpl?: Pick<typeof childProcess, 'spawn'>;
  fsImpl?: Pick<typeof fs, 'existsSync'>;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  requestTimeoutMs?: number;
  expectedContract?: BackendContract;
  startupTimeoutMs?: number;
  responseLimits?: BackendFrameLimits;
}

interface WorkerState {
  child: childProcess.ChildProcess;
  closed: boolean;
  exited: boolean;
  exitCode: number | null;
  closePromise: Promise<void>;
  launch?: BackendLaunch;
  generation: string;
  retiring: boolean;
  stopPromise?: Promise<{ confirmed: boolean }>;
  ready: boolean;
  frames: BackendFrames;
  readinessTimer?: NodeJS.Timeout;
  writeWhenReady?: () => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId: NodeJS.Timeout;
  state: WorkerState;
  onProgress?: (progress: ProcessingProgress) => void;
  deadlineMs: number;
}

export interface PythonProcessManager {
  start(): void;
  stop(): Promise<{ confirmed: boolean }>;
  cancel(): Promise<{ confirmed: boolean }>;
  send(action: string, payload: unknown, options?: { onProgress?: (progress: ProcessingProgress) => void }): Promise<unknown>;
}


async function terminateOwnedTree(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      childProcess.execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, timeout: 2000 }, error => resolve(!error));
    });
  }
  try { process.kill(-pid, 'SIGKILL'); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

async function confirmOwnedTreeStopped(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

export function getPythonRestartDelayMs(attemptIndex: number): number {
  const safeAttempt = Math.max(0, attemptIndex);
  return Math.min(PYTHON_RESTART_BASE_DELAY_MS * (2 ** safeAttempt), PYTHON_RESTART_MAX_DELAY_MS);
}

export function createPythonProcessManager({
  app,
  logger,
  readSettings,
  prepareLaunch,
  temporaryRoot,
  terminateTree = terminateOwnedTree,
  confirmTreeStopped = confirmOwnedTreeStopped,
  onProcessCrashed,
  onFailedToStart,
  childProcessImpl = childProcess,
  fsImpl = fs,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  expectedContract = BACKEND_CONTRACT,
  startupTimeoutMs = 60000,
  responseLimits,
}: PythonProcessManagerDependencies): PythonProcessManager {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > REQUEST_TIMEOUT_MS) {
    throw new Error('Invalid request timeout');
  }
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0 || startupTimeoutMs > 120000) throw new Error('Invalid backend startup timeout');
  // Validate injected test limits before any worker is spawned.
  new BackendFrames(responseLimits);
  let pythonProcess: childProcess.ChildProcess | null = null;
  let restartAttempts = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let appIsQuitting = false;
  let requestCounter = 0;
  let stopping: Promise<{ confirmed: boolean }> | null = null;
  let current: WorkerState | null = null;
  let generationCounter = 0;
  let cancelling: Promise<{ confirmed: boolean }> | null = null;
  let unavailable = false;
  let incompatible = false;
  let startupFailure: string | undefined;

  const pendingRequests = new Map<string, PendingRequest>();

  const clearRestartTimer = (): void => {
    if (restartTimer) {
      clearTimeoutImpl(restartTimer);
      restartTimer = null;
    }
  };

  const rejectPendingRequests = (reason: Error): void => {
    pendingRequests.forEach(({ reject, timeoutId }) => {
      clearTimeoutImpl(timeoutId);
      reject(reason);
    });
    pendingRequests.clear();
  };

  const scheduleRestart = (): void => {
    if (appIsQuitting || pythonProcess || restartTimer || cancelling || unavailable || current?.retiring) {
      return;
    }

    if (restartAttempts >= PYTHON_MAX_RESTART_ATTEMPTS) {
      logger.log(`Python restart limit reached (${PYTHON_MAX_RESTART_ATTEMPTS}), stop retrying`, 'ERROR');
      return;
    }

    const delay = getPythonRestartDelayMs(restartAttempts);
    restartAttempts += 1;
    logger.log(
      `Scheduling Python restart attempt ${restartAttempts}/${PYTHON_MAX_RESTART_ATTEMPTS} in ${delay}ms`,
      'WARN'
    );

    restartTimer = setTimeoutImpl(() => {
      restartTimer = null;
      if (!appIsQuitting && !pythonProcess) {
        start();
      }
    }, delay);
  };

  const start = (): void => {
    if (appIsQuitting || pythonProcess || cancelling || unavailable) {
      return;
    }

    let command: string;
    let args: string[];

    if (app.isPackaged) {
      if (!expectedContract.sourceSha256) throw new Error('Backend build identity is unavailable');
      const execName = process.platform === 'win32' ? 'python_backend.exe' : 'python_backend';
      command = path.join(process.resourcesPath, 'dist', execName);
      args = [];
    } else {
      const scriptPath = path.join(app.getAppPath(), 'python-backend', 'main.py');
      command = process.env.PDF_DESENSITIZATION_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
      args = [scriptPath];
      logger.log('[Python] launch mode: source', 'DEBUG');
      logger.log(`[Python] script exists: ${fsImpl.existsSync(scriptPath)}`, 'DEBUG');
    }

    const settings = readSettings();
    let pythonLogPath = '';
    if (settings.developer_mode && settings.log_folder_path) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      pythonLogPath = path.join(settings.log_folder_path, `python_log_${timestamp}.txt`);
    }

    const launch = prepareLaunch?.();
    const tempRoot = launch?.directory ?? temporaryRoot?.() ?? app.getPath('temp');
    const temporaryEnvironment = { TMPDIR: tempRoot, TEMP: tempRoot, TMP: tempRoot };
    const spawnedProcess = childProcessImpl.spawn(command, args, {
      cwd: app.isPackaged ? process.resourcesPath : app.getAppPath(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: process.platform === 'win32'
        ? {
            ...process.env,
            ...temporaryEnvironment,
            ...launch?.environment,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
            LOG_ENABLED: settings.developer_mode ? '1' : '0',
            LOG_FILE_PATH: pythonLogPath,
          }
        : {
            ...process.env,
            ...temporaryEnvironment,
            ...launch?.environment,
            LOG_ENABLED: settings.developer_mode ? '1' : '0',
            LOG_FILE_PATH: pythonLogPath,
          },
    });

    pythonProcess = spawnedProcess;
    let closeResolve!: () => void;
    const state: WorkerState = { child: spawnedProcess, closed: false, exited: false, exitCode: null,
      closePromise: new Promise<void>(resolve => { closeResolve = resolve; }), launch,
      generation: `backend_${++generationCounter}_${Date.now()}`, retiring: false, ready: false, frames: new BackendFrames(responseLimits) };
    current = state;
    clearRestartTimer();
    const startTime = Date.now();
    let crashHandled = false;
    const failReadiness = (message: string): void => {
      if (current !== state || state.retiring) return;
      incompatible = true;
      unavailable = true;
      onFailedToStart?.({ error: message });
      void retire(new Error(message));
    };
    state.readinessTimer = setTimeoutImpl(() => failReadiness('后端启动超时，请重新启动应用'), startupTimeoutMs);
    state.readinessTimer.unref?.();

    const handleCrash = (code: number | null, message: string, notifyRenderer: boolean): void => {
      if (crashHandled || current !== state || state.retiring) {
        return;
      }

      crashHandled = true;
      clearTimeoutImpl(state.readinessTimer);
      if (Date.now() - startTime >= PYTHON_STABLE_UPTIME_MS) {
        restartAttempts = 0;
      }

      rejectPendingRequests(new Error(message));

      if (notifyRenderer && !appIsQuitting) {
        onProcessCrashed?.({ code });
      }

    };

    spawnedProcess.on('error', (error) => {
      if (current !== state || state.retiring) return;
      logger.log(`Python process failed to start: ${diagnosticErrorKind(error)}`, 'ERROR');
      if (!spawnedProcess.pid) {
        onFailedToStart?.({ error: error.message });
        handleCrash(null, `Python process failed to start: ${error.message}`, false);
        state.closed = true;
        closeResolve();
        if (pythonProcess === spawnedProcess) pythonProcess = null;
        try { launch?.settled(true); } catch (failure) { logger.log(`Python ownership update failed: ${diagnosticErrorKind(failure)}`, 'WARN'); }
        scheduleRestart();
      } else {
        // A failed kill/write can emit error while the child is still alive.
        void retire(error);
      }
    });

    logger.log(`Python process spawned with PID: ${spawnedProcess.pid}`);

    const handleFrame = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      try {
        const response = JSON.parse(trimmed) as {
          type?: string;
          protocol?: number; appVersion?: string; sourceSha256?: string;
          generation?: string;
          requestId?: string;
          success?: boolean;
          data?: unknown;
          error?: string;
          stage?: unknown; message?: unknown; elapsedMs?: unknown; completed?: unknown; total?: unknown;
        };

        if (response?.type === 'ready') {
          if (state.ready) return;
          if (response.protocol !== expectedContract.protocol || response.appVersion !== expectedContract.appVersion ||
              typeof response.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(response.sourceSha256) ||
              (expectedContract.sourceSha256 && response.sourceSha256 !== expectedContract.sourceSha256)) {
            failReadiness('后端与应用版本不一致，请重新构建或安装完整应用');
            return;
          }
          state.ready = true;
          clearTimeoutImpl(state.readinessTimer);
          logger.log(`Python backend ready; elapsedMs=${Math.max(0, Date.now() - startTime)}`);
          const write = state.writeWhenReady; state.writeWhenReady = undefined; write?.();
          return;
        }
        if (!state.ready || !response || typeof response !== 'object' || !response.requestId ||
            (response.generation !== undefined && response.generation !== state.generation)) {
          return;
        }

        const pending = pendingRequests.get(response.requestId);
        if (!pending || pending.state !== state) {
          return;
        }
        if (Date.now() >= pending.deadlineMs) {
          void retire(new Error(`Request timeout after ${requestTimeoutMs}ms`));
          return;
        }

        if (response.type === 'progress') {
          if (response.generation !== state.generation || typeof response.message !== 'string' ||
              response.message.length > 1000 || !isProcessingStage(response.stage) ||
              typeof response.elapsedMs !== 'number' || !Number.isFinite(response.elapsedMs) || response.elapsedMs < 0) return;
          const progress: ProcessingProgress = { stage: response.stage, message: response.message, elapsedMs: response.elapsedMs };
          if (response.completed !== undefined || response.total !== undefined) {
            if (typeof response.completed !== 'number' || typeof response.total !== 'number' ||
                !Number.isSafeInteger(response.completed) || !Number.isSafeInteger(response.total) ||
                response.completed < 0 || response.total <= 0 || response.completed > response.total) return;
            progress.completed = response.completed; progress.total = response.total;
          }
          try { pending.onProgress?.(progress); }
          catch (error) { logger.log(`Progress listener failed: ${diagnosticErrorKind(error)}`, 'WARN'); }
          return;
        }
        // Untyped boolean terminals remain compatible with an older backend.
        if ((response.type !== undefined && response.type !== 'result') || typeof response.success !== 'boolean') return;
        pendingRequests.delete(response.requestId);
        clearTimeoutImpl(pending.timeoutId);
        logger.log(`Python request ${response.requestId} ${response.success ? 'succeeded' : 'failed'}; elapsedMs=${Math.max(0, Date.now() - pending.deadlineMs + requestTimeoutMs)}`,
          response.success ? 'INFO' : 'WARN');

        if (response.success) {
          pending.resolve(response.data);
        } else {
          pending.reject(new Error(response.error ?? 'Unknown error'));
        }
      } catch (error) {
        logger.log(`Failed to parse Python response: ${diagnosticErrorKind(error)}`, 'ERROR');
        if (pendingRequests.size) {
          void retire(new Error('Backend response has invalid JSON'));
        }
      }
    };

    spawnedProcess.stdout?.on('data', (data: Buffer) => {
      if (current !== state || state.retiring || state.exited) return;
      logger.log(`[Python stdout] bytes=${data.length}`, 'DEBUG');
      try {
        state.frames.feed(data, line => {
          if (current !== state || state.retiring || state.exited) return false;
          handleFrame(line);
          return current === state && !state.retiring && !state.exited;
        });
      } catch (error) {
        // A framing violation invalidates this generation, not merely one line.
        // Never log the offending data or allow a following terminal to succeed.
        logger.log(`Python response framing failed: ${diagnosticErrorKind(error)}`, 'ERROR');
        if (!state.ready) {
          failReadiness('后端启动通信异常，请重新启动应用');
        } else {
          // Idle unsolicited faults cannot trigger an unlimited restart loop.
          if (!pendingRequests.size) incompatible = true;
          void retire(error instanceof Error ? error : new Error('Backend response framing failed'));
        }
      }
    });

    spawnedProcess.stderr?.on('data', (data: Buffer) => {
      logger.log(`[Python stderr] bytes=${data.length}`, 'ERROR');
    });

    spawnedProcess.stdin?.on('error', (error: Error) => {
      // EOF/write failures are stream errors, not proof that the worker exited.
      logger.log(`Python input stream failed: ${diagnosticErrorKind(error)}`, 'WARN');
      if (current === state && !state.retiring && !appIsQuitting) void retire(error);
    });

    spawnedProcess.on('exit', (code) => {
      state.exited = true;
      state.frames.clear();
      logger.log(`Python process exited with code ${code}`);
      // A missing/incompatible loader dependency cannot recover through retries.
      // Preserve its fixed message for requests after the initial window event.
      if (process.platform === 'win32' && current === state && !state.ready && !state.retiring && !appIsQuitting) {
        startupFailure = backendStartupFailure(code);
        if (startupFailure) unavailable = true;
      }
      handleCrash(code, startupFailure ?? `Python process exited with code ${code}`, true);
    });
    spawnedProcess.on('close', (code) => {
      clearTimeoutImpl(state.readinessTimer);
      state.closed = true;
      state.frames.clear();
      state.exitCode = code;
      closeResolve();
      if (pythonProcess === spawnedProcess) pythonProcess = null;
      if (current === state && !state.retiring) scheduleRestart();
    });
    launch?.spawned(spawnedProcess.pid);
  };

  const stopGeneration = (state: WorkerState): Promise<{ confirmed: boolean }> => {
    clearTimeoutImpl(state.readinessTimer);
    state.writeWhenReady = undefined;
    state.frames.clear();
    if (state.stopPromise) return state.stopPromise;
    if (state.closed) return Promise.resolve({ confirmed: state.exitCode === 0 });
    const waitClosed = (duration: number): Promise<boolean> => new Promise(resolve => {
      if (state.closed) { resolve(true); return; }
      const timer = setTimeoutImpl(() => resolve(false), duration);
      state.closePromise.then(() => { clearTimeoutImpl(timer); resolve(true); });
    });
    state.stopPromise = (async () => {
      let forced = false;
      let treeTerminated = false;
      try { state.child.stdin?.end(); }
      catch (error) { logger.log(`Python EOF failed: ${diagnosticErrorKind(error)}`, 'WARN'); }
      if (!await waitClosed(5000)) {
        forced = true;
        if (state.child.pid && !state.exited) {
          try { treeTerminated = await terminateTree(state.child.pid); }
          catch (error) { logger.log(`Python termination failed: ${diagnosticErrorKind(error)}`, 'WARN'); }
        }
        await waitClosed(2000);
      }
      let confirmed = state.closed && (forced || state.exitCode === 0);
      if (forced) {
        confirmed = confirmed && treeTerminated && !!state.child.pid &&
          await confirmTreeStopped(state.child.pid);
      }
      try { state.launch?.settled(confirmed); }
      catch (error) { logger.log(`Python ownership update failed: ${diagnosticErrorKind(error)}`, 'WARN'); confirmed = false; }
      return { confirmed };
    })();
    return state.stopPromise;
  };

  const retire = (reason: Error): Promise<{ confirmed: boolean }> => {
    if (cancelling) return cancelling;
    const state = current;
    if (!state) return Promise.resolve({ confirmed: !unavailable });
    state.retiring = true;
    clearRestartTimer();
    pendingRequests.forEach(pending => clearTimeoutImpl(pending.timeoutId));
    cancelling = (async () => {
      let result: { confirmed: boolean };
      try { result = await stopGeneration(state); }
      catch (error) { logger.log(`Backend stop failed: ${diagnosticErrorKind(error)}`, 'WARN'); result = { confirmed: false }; }
      unavailable = !result.confirmed || incompatible;
      rejectPendingRequests(result.confirmed ? reason : new Error('Cannot confirm backend termination; restart application'));
      cancelling = null;
      if (result.confirmed && !appIsQuitting && !incompatible) {
        try { start(); }
        catch (error) { unavailable = true; logger.log(`Backend restart failed: ${diagnosticErrorKind(error)}`, 'ERROR'); }
      }
      return { confirmed: result.confirmed };
    })();
    return cancelling;
  };

  const cancel = (): Promise<{ confirmed: boolean }> => {
    if (cancelling) return cancelling;
    if (!pendingRequests.size) return Promise.resolve({ confirmed: !unavailable });
    return retire(new Error('Request cancelled'));
  };

  const stop = (): Promise<{ confirmed: boolean }> => {
    if (stopping) return stopping;
    appIsQuitting = true;
    clearRestartTimer();
    rejectPendingRequests(new Error('Python process stopped'));
    if (current) current.retiring = true;
    stopping = current ? stopGeneration(current) : Promise.resolve({ confirmed: true });
    return stopping;
  };

  const send: PythonProcessManager['send'] = (action, payload, options) =>
    new Promise((resolve, reject) => {
      if (appIsQuitting) { reject(new Error('Python process stopped')); return; }
      if (startupFailure) { reject(new Error(startupFailure)); return; }
      if (cancelling || unavailable || current?.retiring) { reject(new Error('Python backend is stopping or unavailable')); return; }
      if (pendingRequests.size) { reject(new Error('Python backend is busy')); return; }
      const state = current;
      if (!pythonProcess?.stdin || !state || state.closed || state.exited) {
        reject(new Error('Python process is not running'));
        return;
      }

      const requestId = `req_${++requestCounter}_${Date.now()}`;
      const deadlineMs = Date.now() + requestTimeoutMs;
      const timeoutId = setTimeoutImpl(() => {
        if (pendingRequests.has(requestId)) void retire(new Error(`Request timeout after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);

      pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutId,
        state, onProgress: options?.onProgress, deadlineMs,
      });

      const message = `${JSON.stringify({ requestId, generation: state.generation, deadlineMs, action, payload })}\n`;
      const onWrite = (error?: Error | null) => {
        if (!error) {
          return;
        }

        const pending = pendingRequests.get(requestId);
        if (!pending) {
          return;
        }

        void retire(error);
      };

      const write = (): void => {
        if (!pendingRequests.has(requestId) || current !== state || state.retiring || state.closed || state.exited) return;
        if (Date.now() >= deadlineMs) { void retire(new Error(`Request timeout after ${requestTimeoutMs}ms`)); return; }
        try {
          state.frames.beginResponse();
          if (process.platform === 'win32') {
            state.child.stdin?.write(Buffer.from(message, 'utf-8'), onWrite);
          } else {
            state.child.stdin?.write(message, onWrite);
          }
        } catch (error) { onWrite(error instanceof Error ? error : new Error(String(error))); }
      };
      if (state.ready) write(); else state.writeWhenReady = write;
    });

  return {
    start,
    stop,
    cancel,
    send,
  };
}
