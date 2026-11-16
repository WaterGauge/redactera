import childProcess from 'child_process';
import { createHash } from 'crypto';
import { diagnosticErrorKind } from './diagnostics';
import { freshBackendEnvironment } from './backendLaunchEnv';

export type ProcessIdentity = { state: 'present'; started: string } | { state: 'absent' | 'unknown' };
export interface WindowsSnapshot {
  processes: Record<string, ProcessIdentity>;
  jobs: Record<string, 'empty' | 'active' | 'unknown'>;
}
export type WindowsRecoveryProbe = (pids: number[], jobs: string[]) => WindowsSnapshot | null;
export const validProcessStart = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);

export function windowsJobName(session: string, generation: string): string {
  return 'Global' + String.fromCharCode(92) + 'PDFDesensitization-' +
    createHash('sha256').update(session + ':' + generation).digest('hex');
}

export function createWindowsRecoveryProbe(options: {
  command: string; args: string[]; cwd: string;
  expectedContract: { protocol: number; appVersion: string; sourceSha256?: string };
  spawnSync?: typeof childProcess.spawnSync;
}): WindowsRecoveryProbe {
  return (pids, jobs) => {
    // Transport bounds apply after deduplication and to each request, not to
    // the lifetime of a session or the number of retained crash generations.
    const ids = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0 && pid < 2 ** 32);
    const names = [...new Set(jobs)];
    const snapshot: WindowsSnapshot = {
      processes: Object.fromEntries(pids.map(pid => [String(pid), { state: 'unknown' as const }])),
      jobs: Object.fromEntries(names.map(name => [name, 'unknown' as const])),
    };
    let observed = false;
    const count = Math.max(1, Math.ceil(ids.length / 512), Math.ceil(names.length / 256));
    for (let index = 0; index < count; index++) {
      const selectedIds = ids.slice(index * 512, (index + 1) * 512);
      const selectedJobs = names.slice(index * 256, (index + 1) * 256);
      try {
        const input = JSON.stringify({ pids: selectedIds, jobs: selectedJobs });
        if (Buffer.byteLength(input, 'utf8') > 65536) continue;
        const spawn = options.spawnSync ?? childProcess.spawnSync;
        const query = (timeout: number) => spawn(options.command,
          [...options.args, '--session-probe'], {
            cwd: options.cwd, windowsHide: true, timeout, maxBuffer: 256 * 1024,
            encoding: 'utf8', input, env: freshBackendEnvironment(process.env),
          });
        let result = query(5000);
        // A cold frozen executable can outlast the initial observation budget.
        // Retry only a timeout. Both attempts remain read-only and every result
        // must still prove process incarnation, backend contract and job closure.
        if (diagnosticErrorKind(result.error) === 'ETIMEDOUT') {
          console.warn('Windows recovery observation timed out; retrying once');
          result = query(15000);
        }
        if (result.error || result.status !== 0) {
          console.warn('Windows recovery observation unavailable:', diagnosticErrorKind(result.error));
          continue;
        }
        const data = JSON.parse(String(result.stdout));
        const expected = options.expectedContract, contract = data?.contract;
        if (data?.type !== 'session-process-snapshot' || contract?.protocol !== expected.protocol ||
            contract?.appVersion !== expected.appVersion ||
            (expected.sourceSha256 && contract?.sourceSha256 !== expected.sourceSha256) ||
            !data.processes || !data.jobs) continue;
        observed = true;
        for (const pid of selectedIds) {
          const identity = data.processes[String(pid)];
          if (identity && ['present', 'absent', 'unknown'].includes(identity.state) &&
              (identity.state !== 'present' || validProcessStart(identity.started))) {
            snapshot.processes[String(pid)] = identity;
          }
        }
        for (const name of selectedJobs) {
          if (['empty', 'active', 'unknown'].includes(data.jobs[name])) snapshot.jobs[name] = data.jobs[name];
        }
      } catch { /* This batch stays unknown; independent observations remain valid. */ }
    }
    return observed ? snapshot : null;
  };
}

export function previousProcessState(
  pid: number, expectedStart: unknown, snapshot: WindowsSnapshot | null,
): 'live' | 'gone' | 'unknown' {
  const actual = snapshot?.processes[String(pid)];
  if (actual?.state === 'absent') return 'gone';
  if (actual?.state !== 'present' || !validProcessStart(expectedStart)) return 'unknown';
  return actual.started === expectedStart ? 'live' : 'gone';
}
