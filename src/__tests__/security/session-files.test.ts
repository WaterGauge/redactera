import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFileSession } from '../../main/sessionFiles';
import { writeExportFile } from '../../main/fileExport';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function harness() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(process.env.CR008_TEST_TMPDIR ?? os.tmpdir(), 'session-')));
  roots.push(root);
  const alive = new Set<number>(), groups = new Set<number>();
  const create = (pid = 91321) => createFileSession({
    baseDirectory: path.join(root, 'private'), pid,
    pidAlive: id => alive.has(id), groupAlive: id => groups.has(id),
  });
  return { root, alive, groups, create };
}

it('removes owned inputs and outputs while preserving originals, final exports and logs', () => {
  const h = harness(), session = h.create();
  const original = path.join(h.root, 'original.pdf'), final = path.join(h.root, 'final.pdf'), log = path.join(h.root, 'log.txt');
  [original, final, log].forEach(file => fs.writeFileSync(file, 'USER DATA'));
  fs.writeFileSync(path.join(session.directory, 'dragged.pdf'), 'PRIVATE COPY');
  expect(session.cleanup()).toBe(true);
  expect(fs.existsSync(session.directory)).toBe(false);
  [original, final, log].forEach(file => expect(fs.readFileSync(file, 'utf8')).toBe('USER DATA'));
});

it('keeps a session while its backend is alive even if stop was recorded', () => {
  const h = harness(), session = h.create(), launch = session.prepareBackend();
  launch.spawned(91322); launch.settled(true); h.alive.add(91322);
  expect(session.cleanup()).toBe(false); h.alive.clear();
  expect(session.cleanup()).toBe(true);
});

it('keeps an incomplete launch instead of guessing it has stopped', () => {
  const h = harness(), session = h.create(); session.prepareBackend();
  expect(session.cleanup()).toBe(false);
});

it('accepts a positively confirmed failed spawn without inventing a process', () => {
  const h = harness(), session = h.create(), launch = session.prepareBackend();
  launch.spawned(undefined); launch.settled(true);
  expect(session.cleanup()).toBe(true);
});

it('does not reap another active Main instance', () => {
  const h = harness(); h.alive.add(91321);
  const first = h.create(), secret = path.join(first.directory, 'input.pdf'); fs.writeFileSync(secret, 'PRIVATE');
  const second = h.create(91323);
  expect(fs.readFileSync(secret, 'utf8')).toBe('PRIVATE');
  expect(second.cleanup()).toBe(true);
  h.alive.clear(); const third = h.create(91324);
  expect(fs.existsSync(first.directory)).toBe(false); expect(third.cleanup()).toBe(true);
});

it('reaps an abandoned confirmed session and its precisely owned external staging directory', () => {
  const h = harness(), previous = h.create(), launch = previous.prepareBackend();
  launch.spawned(91322); launch.settled(true);
  const staging = fs.mkdtempSync(path.join(h.root, '.pdf-desensitization-'));
  previous.registerStaging(staging); fs.writeFileSync(path.join(staging, 'output'), 'PRIVATE');
  const current = h.create(91323);
  expect(fs.existsSync(previous.directory)).toBe(false); expect(fs.existsSync(staging)).toBe(false);
  expect(current.recoveryWarnings).toBe(0);
});

it('retains a live worker independently of its exited bootloader', () => {
  const h = harness(), session = h.create(), launch = session.prepareBackend();
  launch.spawned(91322); launch.settled(true);
  fs.writeFileSync(path.join(launch.directory, 'worker.json'), JSON.stringify({
    session: launch.environment.PDF_DESENSITIZATION_SESSION,
    generation: launch.environment.PDF_DESENSITIZATION_GENERATION,
    pid: 91325, parentPid: 91322, state: 'running',
  }));
  h.alive.add(91325); expect(session.cleanup()).toBe(false);
});

it('preserves corrupt worker metadata rather than treating it as absent', () => {
  const h = harness(), session = h.create(), launch = session.prepareBackend();
  launch.spawned(91322); launch.settled(true);
  fs.writeFileSync(path.join(launch.directory, 'worker.json'), 'broken JSON');
  expect(session.cleanup()).toBe(false);
});

it('preserves a damaged ownership journal and reports recovery still pending', () => {
  const h = harness(), old = h.create();
  fs.writeFileSync(path.join(old.directory, 'session.json'), 'broken JSON');
  fs.writeFileSync(path.join(old.directory, 'private.pdf'), 'PRIVATE');
  expect(old.cleanup()).toBe(false);
  const current = h.create(91323);
  expect(current.recoveryWarnings).toBeGreaterThan(0);
  expect(fs.readFileSync(path.join(old.directory, 'private.pdf'), 'utf8')).toBe('PRIVATE');
});

it('never deletes an external directory with a changed ownership token', () => {
  const h = harness(), session = h.create();
  const staging = fs.mkdtempSync(path.join(h.root, '.pdf-desensitization-'));
  session.registerStaging(staging);
  fs.writeFileSync(path.join(staging, '.pdf-desensitization-owner.json'), '{"token":"changed"}');
  fs.writeFileSync(path.join(staging, 'private.pdf'), 'PRESERVE');
  expect(session.cleanup()).toBe(false);
  expect(fs.readFileSync(path.join(staging, 'private.pdf'), 'utf8')).toBe('PRESERVE');
});

it('recognizes private roots and owned external staging as unsafe final destinations', () => {
  const h = harness(), session = h.create();
  const staging = fs.mkdtempSync(path.join(h.root, '.pdf-desensitization-')); session.registerStaging(staging);
  expect(session.isManagedPath(path.join(session.directory, 'final.pdf'))).toBe(true);
  expect(session.isManagedPath(path.join(staging, 'final.pdf'))).toBe(true);
  expect(session.isManagedPath(path.join(h.root, 'final.pdf'))).toBe(false);
});

it('registers staging before opening any payload file and refuses writes if the journal fails', async () => {
  const h = harness(), source = path.join(h.root, 'source.pdf'), target = path.join(h.root, 'final.pdf');
  fs.writeFileSync(source, 'NEW'); fs.writeFileSync(target, 'OLD');
  const open = vi.fn(fs.promises.open.bind(fs.promises));
  await expect(writeExportFile(source, { filePath: target, realParent: h.root },
    { promises: { ...fs.promises, open } },
    { registerStaging: () => { throw new Error('journal unavailable'); }, releaseStaging: vi.fn() }
  )).rejects.toThrow('journal unavailable');
  expect(open).not.toHaveBeenCalled(); expect(fs.readFileSync(target, 'utf8')).toBe('OLD');
});

it('keeps failed export cleanup in the journal and removes it on session cleanup', async () => {
  const h = harness(), session = h.create(), source = path.join(session.directory, 'source.pdf'), target = path.join(h.root, 'final.pdf');
  fs.writeFileSync(source, 'NEW');
  const rm = vi.fn(fs.promises.rm.bind(fs.promises)).mockRejectedValueOnce(new Error('busy'));
  const result = await writeExportFile(source, { filePath: target, realParent: h.root },
    { promises: { ...fs.promises, rm } }, session);
  expect(result.cleanupWarning).toBeDefined();
  expect(JSON.parse(fs.readFileSync(path.join(session.directory, 'session.json'), 'utf8')).stages).toHaveLength(1);
  expect(session.cleanup()).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toBe('NEW');
});


it('retains the recovery journal while an external destination volume is unavailable', () => {
  const h = harness(), session = h.create(), disk = path.join(h.root, 'disk'), offline = path.join(h.root, 'offline');
  fs.mkdirSync(disk);
  const staging = fs.mkdtempSync(path.join(disk, '.pdf-desensitization-'));
  session.registerStaging(staging); fs.writeFileSync(path.join(staging, 'output'), 'PRIVATE');
  fs.renameSync(disk, offline);
  expect(session.cleanup()).toBe(false);
  expect(fs.existsSync(path.join(session.directory, 'session.json'))).toBe(true);
  fs.renameSync(offline, disk);
  expect(session.cleanup()).toBe(true); expect(fs.existsSync(staging)).toBe(false);
});

it('sees staging created by another instance after this instance started', () => {
  const h = harness(); h.alive.add(91321); h.alive.add(91323);
  const first = h.create(), second = h.create(91323);
  const staging = fs.mkdtempSync(path.join(h.root, '.pdf-desensitization-'));
  first.registerStaging(staging);
  expect(second.isManagedPath(path.join(staging, 'final.pdf'))).toBe(true);
});

it('recognizes a real child whose name begins with two dots', () => {
  const h = harness(), session = h.create(), staging = fs.mkdtempSync(path.join(h.root, '.pdf-desensitization-'));
  session.registerStaging(staging);
  const nested = path.join(staging, '..user-exports'); fs.mkdirSync(nested);
  expect(session.isManagedPath(path.join(nested, 'final.pdf'))).toBe(true);
});

it('recognizes the reserved staging namespace before its marker is written', () => {
  const h = harness(), session = h.create(), staging = fs.mkdtempSync(path.join(h.root, '.pdf-desensitization-'));
  expect(session.isManagedPath(path.join(staging, 'final.pdf'))).toBe(true);
});

it('preserves an unexpected user file instead of recursively deleting it', () => {
  const h = harness(), session = h.create(), staging = fs.mkdtempSync(path.join(h.root, '.pdf-desensitization-'));
  session.registerStaging(staging); fs.writeFileSync(path.join(staging, 'final-user.pdf'), 'USER FINAL');
  expect(session.cleanup()).toBe(false);
  expect(fs.readFileSync(path.join(staging, 'final-user.pdf'), 'utf8')).toBe('USER FINAL');
});

it('retains registration if an offline parent makes removal look successful', () => {
  const h = harness(), session = h.create(), disk = path.join(h.root, 'disk');
  fs.mkdirSync(disk); const staging = fs.mkdtempSync(path.join(disk, '.pdf-desensitization-'));
  session.registerStaging(staging); fs.renameSync(disk, disk + '-offline');
  expect(() => session.releaseStaging(staging)).toThrow('unconfirmed');
  expect(JSON.parse(fs.readFileSync(path.join(session.directory, 'session.json'), 'utf8')).stages).toHaveLength(1);
});

it('accepts an owned marker after a volume reconnect changes the parent identity', () => {
  const h = harness(), session = h.create(), disk = path.join(h.root, 'disk');
  fs.mkdirSync(disk); const staging = fs.mkdtempSync(path.join(disk, '.pdf-desensitization-'));
  session.registerStaging(staging); fs.writeFileSync(path.join(staging, 'output'), 'PRIVATE');
  fs.renameSync(disk, disk + '-offline'); fs.mkdirSync(disk);
  fs.renameSync(path.join(disk + '-offline', path.basename(staging)), staging);
  expect(session.cleanup()).toBe(true); expect(fs.existsSync(staging)).toBe(false);
});

it('protects an explicitly configured persistent log path during recovery', () => {
  const h = harness(), old = h.create(), logs = path.join(old.directory, 'logs');
  fs.mkdirSync(logs); fs.writeFileSync(path.join(logs, 'user.log'), 'PERSISTENT LOG');
  const current = createFileSession({ baseDirectory: path.join(h.root, 'private'),
    pidAlive: () => false, groupAlive: () => false, preservePaths: [logs] });
  expect(current.recoveryWarnings).toBeGreaterThan(0);
  expect(fs.readFileSync(path.join(logs, 'user.log'), 'utf8')).toBe('PERSISTENT LOG');
  expect(current.cleanup()).toBe(true);
});

it('classifies a not-yet-created persistent folder using its real existing ancestor', () => {
  const h = harness(), session = h.create();
  expect(session.isManagedPath(path.join(session.directory, 'new-logs', 'user.log'))).toBe(true);
  expect(session.isManagedPath(path.join(h.root, 'new-logs', 'user.log'))).toBe(false);
});
