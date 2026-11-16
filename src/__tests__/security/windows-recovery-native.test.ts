// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { createFileSession } from '../../main/sessionFiles';
import { createWindowsRecoveryProbe, windowsJobName } from '../../main/windowsRecovery';
import type { BackendContract } from '../../main/backendContract';

// Opt in from an authorized isolated Windows account, never log off the host.
const python = process.env.PDF_TEST_PYTHON;
const native = process.platform === 'win32' && !!python;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 20_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) throw new Error('Synthetic native observation timed out');
    await pause(50);
  }
}
async function stopOwned(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  try { await until(() => child.exitCode !== null || child.signalCode !== null, 10_000); }
  catch {
    child.kill(); // only a child created by this test, never a historical PID
    await until(() => child.exitCode !== null || child.signalCode !== null, 10_000);
  }
}

it.skipIf(!native)('native recovery preserves live worker and unproved legacy journal, then reaps the proven synthetic session', async () => {
  if (!python || !path.isAbsolute(python) || !fs.statSync(python).isFile()) throw new Error('Use an absolute approved Python interpreter path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-native-recovery-')));
  const base = path.join(root, 'file-sessions');
  const cwd = path.resolve('python-backend');
  const require = createRequire(path.resolve('package.json'));
  const expectedContract: BackendContract = require('./scripts/backend-contract.cjs').contract(path.resolve('.'));
  const probe = createWindowsRecoveryProbe({ command: python, args: [path.join(cwd, 'main.py')], cwd, expectedContract });
  const oldMain = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  let worker: ChildProcess | undefined;
  let clean = false;
  try {
    if (!oldMain.pid) throw new Error('Synthetic old Main did not start');
    const old = createFileSession({ baseDirectory: base, pid: oldMain.pid, windowsProbe: probe });
    const launch = old.prepareBackend();
    worker = spawn(python, [path.join(cwd, 'main.py')], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...launch.environment, LOG_ENABLED: '0', DEBUG_MODE: '0', TEMP: launch.directory, TMP: launch.directory } });
    if (!worker.pid) throw new Error('Synthetic worker did not start');
    launch.spawned(worker.pid);
    let received = '';
    worker.stdout?.on('data', chunk => { received += String(chunk); });
    worker.stderr?.resume(); // never retain or print native paths
    await until(() => received.includes('\n') || worker?.exitCode !== null);
    expect(JSON.parse(received.split('\n')[0])).toEqual({ type: 'ready', ...expectedContract });
    const identity = JSON.parse(fs.readFileSync(path.join(launch.directory, 'worker.json'), 'utf8'));
    const job = windowsJobName(launch.environment.PDF_DESENSITIZATION_SESSION, launch.environment.PDF_DESENSITIZATION_GENERATION);
    expect(identity.windowsJob).toBe(job);
    expect(probe([identity.pid], [job])).toMatchObject({ processes: { [identity.pid]: { state: 'present' } }, jobs: { [job]: 'active' } });
    const privateFile = path.join(launch.directory, 'synthetic-private.txt');
    fs.writeFileSync(privateFile, 'SYNTHETIC');
    const original = path.join(root, 'original.txt'); fs.writeFileSync(original, 'ORIGINAL');
    // This exercises actual process incarnation and job closure, not OS logout.
    await stopOwned(oldMain);
    const during = createFileSession({ baseDirectory: base, windowsProbe: probe });
    expect(fs.readFileSync(privateFile, 'utf8')).toBe('SYNTHETIC');
    expect(during.recoveryWarnings).toBeGreaterThan(0);
    expect(during.cleanup()).toBe(true);
    await stopOwned(worker);
    expect(worker.exitCode).toBe(0);
    expect(probe([identity.pid], [job])).toMatchObject({ processes: { [identity.pid]: { state: 'absent' } }, jobs: { [job]: 'empty' } });
    // Add a separate legacy record with no incarnation or job proof. It must
    // remain untouched even though the old process is no longer live.
    const legacyId = '11111111-1111-4111-8111-111111111111';
    const legacyGeneration = '22222222-2222-4222-8222-222222222222';
    const legacy = path.join(base, 'session-' + legacyId);
    const legacyBackend = path.join(legacy, 'backend-' + legacyGeneration);
    fs.mkdirSync(legacyBackend, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'session.json'), JSON.stringify({ version: 1, app: 'PDFDesensitization', id: legacyId,
      mainPid: oldMain.pid, backends: [{ id: legacyGeneration, pid: identity.pid, confirmed: true }], stages: [] }));
    fs.writeFileSync(path.join(legacyBackend, 'worker.json'), JSON.stringify({ session: legacyId, generation: legacyGeneration,
      pid: identity.pid, parentPid: oldMain.pid, state: 'stopped' }));
    const legacyMarker = path.join(legacy, 'legacy.txt'); fs.writeFileSync(legacyMarker, 'KEEP');
    const after = createFileSession({ baseDirectory: base, windowsProbe: probe });
    expect(fs.existsSync(old.directory)).toBe(false);
    expect(fs.readFileSync(legacyMarker, 'utf8')).toBe('KEEP');
    expect(after.recoveryWarnings).toBeGreaterThan(0);
    expect(fs.readFileSync(original, 'utf8')).toBe('ORIGINAL');
    expect(after.cleanup()).toBe(true);
    clean = true;
  } finally {
    await stopOwned(oldMain);
    if (worker) await stopOwned(worker);
    // If the native controls fail, retain this synthetic root for diagnosis.
    // Never delete a real application session or global temporary namespace.
    if (clean) fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
