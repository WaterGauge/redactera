import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directories: string[] = [];
const scripts = ['set-version.js', 'release-version.cjs'];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redactera-version-'));
  directories.push(root);
  const scriptDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptDir);
  for (const name of scripts) fs.copyFileSync(path.join(process.cwd(), 'scripts', name), path.join(scriptDir, name));
  const name = 'redactera-fixture';
  const version = '1.2.0';
  const pkg = { name, version, dependencies: { 'fixture-dep': '3.0.0' } };
  const lock = { name, version, lockfileVersion: 3, packages: {
    '': { ...pkg },
    'node_modules/fixture-dep': { version: '3.0.0' },
  } };
  const packageFile = path.join(root, 'package.json');
  const lockFile = path.join(root, 'package-lock.json');
  fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  const invoke = (script: string, value: string) =>
    spawnSync(process.execPath, [path.join(scriptDir, script), value], { cwd: root, encoding: 'utf8' });
  const read = () => [fs.readFileSync(packageFile, 'utf8'), fs.readFileSync(lockFile, 'utf8')];
  return { root, scriptDir, invoke, read };
}

describe('release version tools', () => {
  it.each(['2.0.0-alpha.1', '2.0.0-beta.10', '2.0.0-rc.1', '2.0.0'])(
    'keeps package and lock versions in sync for %s', version => {
      const f = fixture();
      const before = f.read();
      expect(f.invoke('set-version.js', version).status).toBe(0);
      const [pkg, lock] = f.read().map(text => JSON.parse(text));
      expect(pkg.version).toBe(version);
      expect(lock.version).toBe(version);
      expect(lock.packages[''].version).toBe(version);
      expect(lock.packages['node_modules/fixture-dep']).toEqual(JSON.parse(before[1]).packages['node_modules/fixture-dep']);
      const verified = f.invoke('release-version.cjs', 'refs/tags/v' + version);
      expect(verified.status).toBe(0);
      expect(JSON.parse(verified.stdout)).toEqual({ version, prerelease: version.includes('-') });
      const updated = f.read();
      expect(f.invoke('set-version.js', version).status).toBe(0);
      expect(f.read()).toEqual(updated);
    }
  );

  it.each(['02.0.0', '2.0.0-beta.01', '2.0.0-beta.0', '2.0.0+build', '2.0.0-debug', '2.0.0\n'])(
    'rejects %j without rewriting either file', version => {
      const f = fixture();
      const before = f.read();
      expect(f.invoke('set-version.js', version).status).toBe(1);
      expect(f.read()).toEqual(before);
    }
  );

  it('fails a mismatching ref or lock version without modifying the source', () => {
    const f = fixture();
    const before = f.read();
    expect(f.invoke('release-version.cjs', 'refs/tags/v1.2.1').status).toBe(1);
    expect(f.invoke('release-version.cjs', 'refs/heads/v1.2.0').status).toBe(1);
    expect(f.read()).toEqual(before);
    const lock = JSON.parse(before[1]);
    lock.packages[''].version = '1.2.1';
    fs.writeFileSync(path.join(f.root, 'package-lock.json'), JSON.stringify(lock));
    const mismatch = f.read();
    expect(f.invoke('release-version.cjs', 'refs/tags/v1.2.0').status).toBe(1);
    expect(f.read()).toEqual(mismatch);
    expect(f.invoke('set-version.js', '1.2.0').status).toBe(0);
    expect(f.invoke('release-version.cjs', 'refs/tags/v1.2.0').status).toBe(0);
  });

  it('leaves both version files intact when another writer holds the lock', () => {
    const f = fixture();
    const before = f.read();
    const state = path.join(f.root, '.project-state');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'set-version.lock'), 'synthetic writer');
    const result = f.invoke('set-version.js', '2.0.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Another version update');
    expect(f.read()).toEqual(before);
  });

  it('restores the lock file when writing the package manifest fails', () => {
    const f = fixture();
    const before = f.read();
    const script = [
      "const fs = require('node:fs'); const path = require('node:path');",
      'const entry = process.argv[1]; const rename = fs.renameSync;',
      'fs.renameSync = (from, to) => {',
      "  if (path.basename(to) === 'package.json') throw Error('synthetic manifest write failure');",
      '  return rename(from, to);',
      '};',
      "process.argv = [process.execPath, entry, '2.0.0'];",
      'require(entry);',
    ].join('\n');
    const failed = spawnSync(process.execPath, ['-e', script, path.join(f.scriptDir, 'set-version.js')], { cwd: f.root, encoding: 'utf8' });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('synthetic manifest write failure');
    expect(f.read()).toEqual(before);
    expect(f.invoke('set-version.js', '2.0.0').status).toBe(0);
  });
});
