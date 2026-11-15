import { diagnosticErrorKind } from './diagnostics';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { previousProcessState, validProcessStart, windowsJobName, type WindowsRecoveryProbe, type WindowsSnapshot } from './windowsRecovery';

const APP = 'PDFDesensitization';
const JOURNAL = 'session.json';
const STAGE_MARKER = '.pdf-desensitization-owner.json';
export const EXPORT_STAGING_PREFIX = '.pdf-desensitization-';
const UUID = /^[0-9a-f-]{36}$/;

interface BackendRecord { id: string; pid: number | null; confirmed: boolean }
interface StageRecord { directory: string; realPath: string; token: string; parentIdentity?: string }
interface Journal {
  version: 1; app: typeof APP; id: string; mainPid: number; mainStarted?: string;
  backends: BackendRecord[]; stages: StageRecord[];
}
export interface BackendLaunch {
  directory: string;
  environment: Record<string, string>;
  spawned(pid: number | undefined): void;
  settled(confirmed: boolean): void;
}
export interface StagingOwner {
  registerStaging(directory: string): void;
  releaseStaging(directory: string): void;
  beforeStagingCleanup?(directory: string): void;
  isManagedPath?(filePath: string): boolean;
}
export interface FileSession extends StagingOwner {
  directory: string;
  recoveryWarnings: number;
  prepareBackend(): BackendLaunch;
  isManagedPath(filePath: string): boolean;
  cleanup(): boolean;
}

function inside(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export function isGroupAlive(pid: number): boolean {
  if (process.platform === 'win32') return true;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function readObject(file: string): Record<string, unknown> | null {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 2 ** 32;
}
function readJournal(directory: string): Journal | null {
  const value = readObject(path.join(directory, JOURNAL));
  if (!value || value.version !== 1 || value.app !== APP ||
      typeof value.id !== 'string' || !UUID.test(value.id) ||
      path.basename(directory) !== 'session-' + value.id || !positive(value.mainPid) ||
      !Array.isArray(value.backends) || !Array.isArray(value.stages) ||
      (value.mainStarted !== undefined && !validProcessStart(value.mainStarted))) return null;
  for (const backend of value.backends) {
    if (!backend || typeof backend.id !== 'string' || !UUID.test(backend.id) ||
        !(backend.pid === null || positive(backend.pid)) || typeof backend.confirmed !== 'boolean') return null;
  }
  for (const stage of value.stages) {
    if (!stage || typeof stage.directory !== 'string' || !path.isAbsolute(stage.directory) ||
        typeof stage.realPath !== 'string' || !path.isAbsolute(stage.realPath) ||
        typeof stage.token !== 'string' || !UUID.test(stage.token) ||
        !path.basename(stage.directory).startsWith(EXPORT_STAGING_PREFIX) ||
        (stage.parentIdentity !== undefined && typeof stage.parentIdentity !== 'string')) return null;
  }
  return value as unknown as Journal;
}

function resolveCandidate(filePath: string): string {
  let current = path.resolve(filePath);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function writeJournal(directory: string, journal: Journal): void {
  const temporary = path.join(directory, '.journal-' + randomUUID());
  try {
    fs.writeFileSync(temporary, JSON.stringify(journal), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, JOURNAL));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function createFileSession(options: {
  baseDirectory: string;
  pid?: number;
  pidAlive?: (pid: number) => boolean;
  groupAlive?: (pid: number) => boolean;
  preservePaths?: string[];
  windowsProbe?: WindowsRecoveryProbe;
  platform?: NodeJS.Platform;
}): FileSession {
  const pid = options.pid ?? process.pid;
  const windows = (options.platform ?? process.platform) === 'win32';
  const alive = options.pidAlive ?? isPidAlive;
  const groupAlive = options.groupAlive ?? isGroupAlive;
  fs.mkdirSync(options.baseDirectory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(options.baseDirectory).isDirectory()) throw new Error('Invalid session directory');
  const base = fs.realpathSync(options.baseDirectory);
  const knownStages = new Set<string>();
  const protectedPaths = (options.preservePaths ?? []).filter(Boolean).map(resolveCandidate);

  const observe = (
    entries: { directory: string; journal: Journal }[], extraPids: number[] = [],
  ): WindowsSnapshot | null => {
    if (!options.windowsProbe) return null;
    const pids = [...extraPids], jobs: string[] = [];
    for (const { directory, journal } of entries) {
      pids.push(journal.mainPid);
      for (const backend of journal.backends) {
        if (backend.pid) pids.push(backend.pid);
        const worker = readObject(path.join(directory, 'backend-' + backend.id, 'worker.json'));
        if (worker && worker.session === journal.id && worker.generation === backend.id &&
            positive(worker.pid) && positive(worker.parentPid) &&
            (worker.state === 'running' || worker.state === 'stopped')) {
          pids.push(worker.pid, worker.parentPid);
        }
        jobs.push(windowsJobName(journal.id, backend.id));
      }
    }
    try { return options.windowsProbe(pids, jobs); } catch { return null; }
  };

  const backendSafe = (directory: string, journal: Journal, snapshot: WindowsSnapshot | null): boolean => journal.backends.every(backend => {
    const backendDirectory = path.join(directory, 'backend-' + backend.id);
    if (!fs.lstatSync(backendDirectory).isDirectory() || fs.realpathSync(backendDirectory) !== backendDirectory) return false;
    const workerFile = path.join(backendDirectory, 'worker.json');
    const worker = readObject(workerFile);
    const validWorker = worker && worker.session === journal.id && worker.generation === backend.id &&
      positive(worker.pid) && positive(worker.parentPid) &&
      (worker.state === 'running' || worker.state === 'stopped');
    try { fs.lstatSync(workerFile); if (!validWorker) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    if (windows && options.windowsProbe) {
      const rootStarted = validWorker && backend.pid === worker.pid ? worker.processStarted
        : validWorker && backend.pid === worker.parentPid ? worker.parentStarted : undefined;
      if (backend.pid && previousProcessState(backend.pid, rootStarted, snapshot) !== 'gone') {
        console.warn('Temporary session retained: backend root exit unconfirmed');
        return false;
      }
      if (validWorker && previousProcessState(worker.pid as number, worker.processStarted, snapshot) !== 'gone') {
        console.warn('Temporary session retained: worker exit unconfirmed');
        return false;
      }
      if (validWorker && !backend.pid && worker.parentPid !== journal.mainPid &&
          previousProcessState(worker.parentPid as number, worker.parentStarted, snapshot) !== 'gone') return false;
      if (validWorker) {
        const expectedJob = windowsJobName(journal.id, backend.id);
        // A legacy running/stopped record cannot establish descendant closure.
        // Missing, inaccessible or foreign jobs must never unlock deletion.
        const closed = worker.windowsJob === expectedJob && validProcessStart(worker.processStarted) &&
          snapshot?.jobs[expectedJob] === 'empty';
        if (!closed) console.warn('Temporary session retained: job closure unconfirmed');
        return closed;
      }
      // No registered worker accepted documents. A positively confirmed failed
      // launch is still safe once its root has demonstrably gone.
      return backend.confirmed;
    }
    if (backend.pid && alive(backend.pid)) return false;
    if (validWorker && alive(worker.pid as number)) return false;
    if (!backend.pid && validWorker && worker.parentPid !== journal.mainPid && alive(worker.parentPid as number)) return false;
    if (backend.pid && !windows && groupAlive(backend.pid)) return false;
    if (validWorker && !windows && positive(worker.groupPid) && groupAlive(worker.groupPid)) return false;
    if (backend.confirmed) return true;
    if (validWorker && worker.state === 'stopped') return true;
    return !!validWorker && !windows && positive(worker.groupPid) && !groupAlive(worker.groupPid);
  });

  const parentIdentity = (directory: string): string => {
    const stat = fs.statSync(directory, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  };
  const sameParent = (stage: StageRecord): boolean => {
    try {
      return !!stage.parentIdentity &&
        fs.realpathSync(path.dirname(stage.directory)) === path.dirname(stage.realPath) &&
        parentIdentity(path.dirname(stage.realPath)) === stage.parentIdentity;
    } catch { return false; }
  };
  const stageInfo = (directory: string): fs.Stats | null => {
    try { return fs.lstatSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const checkStage = (stage: StageRecord, session: string): void => {
    const info = stageInfo(stage.directory);
    if (!info) {
      if (!sameParent(stage)) throw new Error('Staging volume is unavailable or changed');
      return;
    }
    if (!info.isDirectory() || fs.realpathSync(stage.directory) !== stage.realPath) throw new Error('Staging identity changed');
    const marker = readObject(path.join(stage.directory, STAGE_MARKER));
    if (!marker || marker.app !== APP || marker.session !== session || marker.token !== stage.token) throw new Error('Staging owner changed');
    // Never recursively erase files placed here by another application/instance.
    for (const name of fs.readdirSync(stage.directory)) {
      if (![STAGE_MARKER, 'output'].includes(name) || !fs.lstatSync(path.join(stage.directory, name)).isFile()) {
        throw new Error('Staging directory contains unowned entries');
      }
    }
  };

  const removeOwned = (directory: string, journal: Journal, snapshot?: WindowsSnapshot | null): boolean => {
    try {
      if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory ||
          !inside(directory, base) || directory === base || protectedPaths.some(file => inside(file, directory)) ||
          journal.stages.some(stage => protectedPaths.some(file => inside(file, stage.realPath))) || !backendSafe(directory, journal, snapshot === undefined ? observe([{ directory, journal }]) : snapshot)) return false;
      // Check the whole journal before deleting any external directory.
      journal.stages.forEach(stage => {
        checkStage(stage, journal.id);
        if (stageInfo(stage.directory)) stage.parentIdentity = parentIdentity(path.dirname(stage.realPath));
      });
      // A valid marker lets a reconnected volume refresh its device identity.
      // Persist that identity before deleting any bytes on the external disk.
      writeJournal(directory, journal);
      for (const stage of [...journal.stages]) {
        const present = stageInfo(stage.directory);
        if (present) {
          // ENOENT must remain an error if the destination volume vanished.
          fs.rmSync(stage.directory, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
        } else if (!sameParent(stage)) return false;
        if (stage.parentIdentity && !sameParent(stage)) return false;
        journal.stages = journal.stages.filter(item => item !== stage);
        writeJournal(directory, journal);
        knownStages.delete(stage.realPath);
      }
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch (error) {
      console.warn('Temporary session cleanup deferred:', diagnosticErrorKind(error));
      return false;
    }
  };

  let recoveryWarnings = 0;
  const candidates = fs.readdirSync(base).filter(name => name.startsWith('session-'))
    .map(name => { const directory = path.join(base, name); return { directory, journal: readJournal(directory) }; });
  // One bounded startup observation, even after many retained crash records.
  // A dead process incarnation/job cannot resurrect during this cleanup pass.
  const recognized = candidates.filter((entry): entry is { directory: string; journal: Journal } => entry.journal !== null);
  const startupSnapshot = windows && options.windowsProbe ? observe(recognized, [pid]) : undefined;
  for (const { directory, journal: previous } of candidates) {
    try {
      if (!previous || !fs.lstatSync(directory).isDirectory()) { recoveryWarnings++; continue; }
      previous.stages.forEach(stage => knownStages.add(stage.realPath));
      const snapshot = startupSnapshot;
      if (windows && options.windowsProbe) {
        const owner = previousProcessState(previous.mainPid, previous.mainStarted, snapshot ?? null);
        if (owner === 'live') continue;
        if (owner === 'unknown') { recoveryWarnings++; continue; }
      } else if (alive(previous.mainPid)) continue;
      if (!removeOwned(directory, previous, snapshot)) recoveryWarnings++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') recoveryWarnings++;
    }
  }

  const id = randomUUID();
  const directory = path.join(base, 'session-' + id);
  fs.mkdirSync(directory, { mode: 0o700 });
  const journal: Journal = { version: 1, app: APP, id, mainPid: pid, backends: [], stages: [] };
  if (windows && options.windowsProbe) {
    try {
      const own = startupSnapshot?.processes[String(pid)] ?? options.windowsProbe([pid], [])?.processes[String(pid)];
      if (own?.state === 'present') journal.mainStarted = own.started;
    } catch { /* Future recovery preserves unknown identity and warns. */ }
  }
  const persist = (): void => writeJournal(directory, journal);
  persist();

  return {
    directory, recoveryWarnings,
    prepareBackend(): BackendLaunch {
      const record: BackendRecord = { id: randomUUID(), pid: null, confirmed: false };
      const backend = path.join(directory, 'backend-' + record.id);
      fs.mkdirSync(backend, { mode: 0o700 });
      journal.backends.push(record);
      persist(); // Before spawning, an incomplete launch is conservatively retained.
      return {
        directory: backend,
        environment: {
          PDF_DESENSITIZATION_TEMP_ROOT: backend,
          PDF_DESENSITIZATION_SESSION: id,
          PDF_DESENSITIZATION_GENERATION: record.id,
        },
        spawned(value): void { record.pid = value ?? null; persist(); },
        settled(confirmed): void { record.confirmed = confirmed; persist(); },
      };
    },
    registerStaging(staging): void {
      const realPath = fs.realpathSync(staging);
      if (!fs.lstatSync(staging).isDirectory() || !path.basename(staging).startsWith(EXPORT_STAGING_PREFIX)) {
        throw new Error('Invalid export staging directory');
      }
      const token = randomUUID();
      fs.writeFileSync(path.join(staging, STAGE_MARKER),
        JSON.stringify({ app: APP, session: id, token }), { flag: 'wx', mode: 0o600 });
      journal.stages.push({ directory: staging, realPath, token, parentIdentity: parentIdentity(path.dirname(realPath)) });
      knownStages.add(realPath);
      persist(); // No export byte may be written until this succeeds.
    },
    beforeStagingCleanup(staging): void {
      const record = journal.stages.find(stage => stage.directory === staging);
      if (!record) {
        if (fs.readdirSync(staging).length) throw new Error('Unregistered staging contents');
        return;
      }
      checkStage(record, id);
      if (stageInfo(staging)) {
        record.parentIdentity = parentIdentity(path.dirname(record.realPath));
        persist();
      }
    },
    releaseStaging(staging): void {
      const record = journal.stages.find(stage => stage.directory === staging);
      if (record && (!sameParent(record) || stageInfo(staging))) throw new Error('Staging removal is unconfirmed');
      if (record) knownStages.delete(record.realPath);
      journal.stages = journal.stages.filter(stage => stage.directory !== staging);
      persist();
    },
    isManagedPath(filePath): boolean {
      const resolved = resolveCandidate(filePath);
      if (inside(resolved, base) || [...knownStages].some(stage => inside(resolved, stage))) return true;
      // This namespace is reserved for final-save rejection, never for deletion.
      // It covers the mkdir-to-marker gap and other instances/profiles.
      for (let ancestor = path.dirname(resolved);;) {
        const name = path.basename(ancestor);
        if (name.startsWith(EXPORT_STAGING_PREFIX)) return true;
        if (name.startsWith('session-') && UUID.test(name.slice(8)) &&
            (path.basename(path.dirname(ancestor)) === 'file-sessions' || readJournal(ancestor))) return true;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      return false;
    },
    cleanup(): boolean {
      const saved = readJournal(directory);
      return !!saved && saved.id === id && removeOwned(directory, saved);
    },
  };
}
