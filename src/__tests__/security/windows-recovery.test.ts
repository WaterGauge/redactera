import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFileSession } from '../../main/sessionFiles';
import { createWindowsRecoveryProbe, previousProcessState, windowsJobName, type WindowsSnapshot } from '../../main/windowsRecovery';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function harness() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.CR008_TEST_TMPDIR ?? os.tmpdir(), 'win-recovery-')));
  roots.push(root);
  const starts = new Map<number, string>([[91501, '101'], [91502, '102'], [91503, '103']]);
  let job: 'empty' | 'active' | 'unknown' = 'active', unavailable = false;
  const probe = (pids: number[], jobs: string[]): WindowsSnapshot | null => unavailable ? null : ({
    processes: Object.fromEntries(pids.map(pid => {
      const started = starts.get(pid);
      return [String(pid), started === undefined ? { state: 'absent' as const } : { state: 'present' as const, started }];
    })),
    jobs: Object.fromEntries(jobs.map(name => [name, job])),
  });
  const create = (pid = 91501) => createFileSession({ baseDirectory: path.join(root, 'private'),
    pid, windowsProbe: probe, platform: 'win32' });
  const first = create(), launch = first.prepareBackend(); launch.spawned(91502);
  const identity = { session: launch.environment.PDF_DESENSITIZATION_SESSION,
    generation: launch.environment.PDF_DESENSITIZATION_GENERATION,
    pid: 91502, parentPid: 91501, state: 'running', processStarted: '102', parentStarted: '101',
    windowsJob: windowsJobName(launch.environment.PDF_DESENSITIZATION_SESSION, launch.environment.PDF_DESENSITIZATION_GENERATION) };
  const worker = path.join(launch.directory, 'worker.json');
  fs.writeFileSync(worker, JSON.stringify(identity));
  const secret = path.join(launch.directory, 'synthetic-private-copy.pdf'); fs.writeFileSync(secret, 'PRIVATE');
  const stop = () => { starts.delete(91501); starts.delete(91502); job = 'empty'; };
  return { root, starts, create, first, launch, worker, identity, secret, stop,
    setJob: (state: typeof job) => { job = state; }, failProbe: () => { unavailable = true; } };
}

it('reaps a force-exited managed tree after an independently observed empty job', () => {
  const h = harness(), staging = fs.mkdtempSync(path.join(h.root, '.pdf-desensitization-'));
  h.first.registerStaging(staging); fs.writeFileSync(path.join(staging, 'output'), 'PRIVATE EXPORT STAGING');
  const original = path.join(h.root, 'original.pdf'); fs.writeFileSync(original, 'USER ORIGINAL');
  h.stop(); const next = h.create(91503);
  expect(fs.existsSync(h.first.directory)).toBe(false);
  expect(fs.existsSync(staging)).toBe(false);
  expect(fs.readFileSync(original, 'utf8')).toBe('USER ORIGINAL');
  expect(next.recoveryWarnings).toBe(0);
});

it('preserves an active original Main without a misleading recovery warning', () => {
  const h = harness(), next = h.create(91503);
  expect(next.recoveryWarnings).toBe(0); expect(fs.existsSync(h.secret)).toBe(true);
});

it('does not mistake a reused Main/worker PID for the original incarnation or kill its new owner', () => {
  const h = harness(); h.stop(); h.starts.set(91501, '201'); h.starts.set(91502, '202');
  const kill = vi.spyOn(process, 'kill');
  const next = h.create(91503);
  expect(fs.existsSync(h.first.directory)).toBe(false); expect(next.recoveryWarnings).toBe(0);
  expect(kill).not.toHaveBeenCalled(); expect(h.starts.get(91501)).toBe('201');
});

it.each(['active', 'unknown'] as const)('retains the private copy while its job is %s although both recorded PIDs exited', state => {
  const h = harness(); h.stop(); h.setJob(state);
  expect(h.create(91503).recoveryWarnings).toBeGreaterThan(0);
  expect(fs.readFileSync(h.secret, 'utf8')).toBe('PRIVATE');
});

it('refuses cleanup of the current worker while its descendants remain in the job', () => {
  const h = harness(); h.stop(); h.setJob('active'); h.launch.settled(true);
  expect(h.first.cleanup()).toBe(false);
  h.setJob('empty'); expect(h.first.cleanup()).toBe(true);
});

it.each(['missing', 'foreign', 'corrupt'] as const)('preserves %s tree proof even if a root-only stop was confirmed', mode => {
  const h = harness(); h.stop(); h.launch.settled(true);
  if (mode === 'corrupt') fs.writeFileSync(h.worker, 'not json');
  else fs.writeFileSync(h.worker, JSON.stringify({ ...h.identity,
    windowsJob: mode === 'missing' ? undefined : windowsJobName('other', 'other') }));
  expect(h.create(91503).recoveryWarnings).toBeGreaterThan(0);
  expect(fs.existsSync(h.secret)).toBe(true);
});

it('reports uncertainty instead of silently skipping a legacy Main PID with no creation identity', () => {
  const h = harness(), journal = path.join(h.first.directory, 'session.json');
  const data = JSON.parse(fs.readFileSync(journal, 'utf8')); delete data.mainStarted;
  fs.writeFileSync(journal, JSON.stringify(data));
  expect(h.create(91503).recoveryWarnings).toBeGreaterThan(0); expect(fs.existsSync(h.secret)).toBe(true);
});

it('preserves old data on a denied, unavailable or timed-out probe', () => {
  const h = harness(); h.stop(); h.failProbe();
  expect(h.create(91503).recoveryWarnings).toBeGreaterThan(0); expect(fs.existsSync(h.secret)).toBe(true);
});

it('retains unknown external contents even after process/tree closure is proved', () => {
  const h = harness(), staging = fs.mkdtempSync(path.join(h.root, '.pdf-desensitization-'));
  h.first.registerStaging(staging); fs.writeFileSync(path.join(staging, 'user.pdf'), 'USER');
  h.stop(); expect(h.create(91503).recoveryWarnings).toBeGreaterThan(0);
  expect(fs.existsSync(h.secret)).toBe(true); expect(fs.readFileSync(path.join(staging, 'user.pdf'), 'utf8')).toBe('USER');
});

it('does not treat absent observation as proof of process exit', () => {
  expect(previousProcessState(1, '123', null)).toBe('unknown');
  expect(previousProcessState(1, '123', { processes: { 1: { state: 'unknown' } }, jobs: {} })).toBe('unknown');
});

it('accepts only a complete, same-contract query response', () => {
  const contract = { protocol: 1, appVersion: '2.0.0-test', sourceSha256: 'a'.repeat(64) };
  const invoke = (data: unknown, status = 0) => createWindowsRecoveryProbe({
    command: 'owned-backend', args: [], cwd: os.tmpdir(), expectedContract: contract,
    spawnSync: vi.fn(() => ({ status, stdout: JSON.stringify(data) })) as never,
  })([12], ['job']);
  const response = { type: 'session-process-snapshot', contract,
    processes: { 12: { state: 'absent' } }, jobs: { job: 'empty' } };
  expect(invoke(response)).toMatchObject({ jobs: { job: 'empty' } });
  expect(invoke({ ...response, contract: { ...contract, sourceSha256: 'b'.repeat(64) } })).toBeNull();
  expect(invoke({ ...response, processes: {} })?.processes['12'].state).toBe('unknown');
  expect(invoke(response, 1)).toBeNull();
});


it('retries a timed-out native observation once before accepting independent exit proof', () => {
  const contract = { protocol: 1, appVersion: 'synthetic', sourceSha256: 'a'.repeat(64) };
  const spawn = vi.fn().mockReturnValueOnce({ error: { code: 'ETIMEDOUT' }, status: null, stdout: '' })
    .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ type: 'session-process-snapshot', contract,
      processes: { 12: { state: 'absent' } }, jobs: { job: 'empty' } }) });
  const probe = createWindowsRecoveryProbe({ command: 'owned', args: ['main.py'], cwd: os.tmpdir(),
    expectedContract: contract, spawnSync: spawn as never });
  expect(probe([12], ['job'])).toEqual({ processes: { 12: { state: 'absent' } }, jobs: { job: 'empty' } });
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawn.mock.calls[0][1]).toEqual(['main.py', '--session-probe']);
  expect(spawn.mock.calls[0][2]).toMatchObject({ env: { PYINSTALLER_RESET_ENVIRONMENT: '1' } });
  expect(spawn.mock.calls[0][2].timeout).toBe(5000);
  expect(spawn.mock.calls[1][2]).toEqual({ ...spawn.mock.calls[0][2], timeout: 15000 });
});

it('retains files when both bounded observations time out and does not retry permission failures', () => {
  for (const code of ['ETIMEDOUT', 'EACCES']) {
    const h = harness(); h.stop();
    const spawn = vi.fn(() => ({ error: { code }, status: null, stdout: '' }));
    const probe = createWindowsRecoveryProbe({ command: 'owned', args: [], cwd: os.tmpdir(),
      expectedContract: { protocol: 1, appVersion: 'synthetic' }, spawnSync: spawn as never });
    const next = createFileSession({ baseDirectory: path.join(h.root, 'private'), pid: 91503,
      windowsProbe: probe, platform: 'win32' });
    expect(next.recoveryWarnings).toBeGreaterThan(0);
    expect(fs.existsSync(h.secret)).toBe(true);
    // One startup batch, then the current Main identity fallback.
    expect(spawn).toHaveBeenCalledTimes(code === 'ETIMEDOUT' ? 4 : 2);
  }
});


function nativeProtocolProbe() {
  const contract = { protocol: 1, appVersion: 'synthetic', sourceSha256: 'a'.repeat(64) };
  const spawn = vi.fn((_command: unknown, _args: unknown, options: { input: string }) => {
    const query = JSON.parse(options.input) as { pids: number[]; jobs: string[] };
    if (query.pids.length > 512 || query.jobs.length > 256 ||
        query.pids.some(pid => !Number.isInteger(pid) || pid <= 0 || pid >= 2 ** 32)) {
      return { status: 1, stdout: '{}' };
    }
    return { status: 0, stdout: JSON.stringify({ type: 'session-process-snapshot', contract,
      processes: Object.fromEntries(query.pids.map(pid => [String(pid),
        pid === 91505 ? { state: 'present', started: '105' } : { state: 'absent' }])),
      jobs: Object.fromEntries(query.jobs.map(name => [name, 'empty'])),
    }) };
  });
  return { spawn, probe: createWindowsRecoveryProbe({ command: 'owned', args: [], cwd: os.tmpdir(),
    expectedContract: contract, spawnSync: spawn as never }) };
}

it('recovers more than 256 exited generations through bounded deduplicated queries', () => {
  const h = harness();
  for (let i = 1; i < 300; i++) {
    const launch = h.first.prepareBackend(); launch.spawned(91502);
    fs.writeFileSync(path.join(launch.directory, 'worker.json'), JSON.stringify({
      ...h.identity, session: launch.environment.PDF_DESENSITIZATION_SESSION,
      generation: launch.environment.PDF_DESENSITIZATION_GENERATION,
      windowsJob: windowsJobName(launch.environment.PDF_DESENSITIZATION_SESSION, launch.environment.PDF_DESENSITIZATION_GENERATION),
    }));
  }
  h.stop(); const protocol = nativeProtocolProbe();
  const next = createFileSession({ baseDirectory: path.join(h.root, 'private'), pid: 91505,
    windowsProbe: protocol.probe, platform: 'win32' });
  expect(next.recoveryWarnings).toBe(0); expect(fs.existsSync(h.first.directory)).toBe(false);
  expect(protocol.spawn).toHaveBeenCalled();
  for (const call of protocol.spawn.mock.calls) {
    const input = JSON.parse(call[2].input);
    expect(input.pids.length).toBeLessThanOrEqual(512);
    expect(input.jobs.length).toBeLessThanOrEqual(256);
    expect(new Set(input.pids).size).toBe(input.pids.length);
  }
});

it('keeps a corrupt worker PID from blocking an unrelated recoverable session', () => {
  const h = harness(), valid = h.create(91503), launch = valid.prepareBackend(); launch.spawned(91504);
  fs.writeFileSync(path.join(launch.directory, 'worker.json'), JSON.stringify({
    ...h.identity, generation: launch.environment.PDF_DESENSITIZATION_GENERATION,
    session: launch.environment.PDF_DESENSITIZATION_SESSION, pid: 91504, processStarted: '104',
    windowsJob: windowsJobName(launch.environment.PDF_DESENSITIZATION_SESSION, launch.environment.PDF_DESENSITIZATION_GENERATION),
  }));
  fs.writeFileSync(h.worker, JSON.stringify({ ...h.identity, pid: 2 ** 32 }));
  h.stop(); const protocol = nativeProtocolProbe();
  const next = createFileSession({ baseDirectory: path.join(h.root, 'private'), pid: 91505,
    windowsProbe: protocol.probe, platform: 'win32' });
  expect(next.recoveryWarnings).toBeGreaterThan(0);
  expect(fs.existsSync(h.secret)).toBe(true);
  expect(fs.existsSync(valid.directory)).toBe(false);
});
