import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redactera-icon-'));
  directories.push(root);
  const manifest = JSON.parse(fs.readFileSync('assets/icon-manifest.json', 'utf8'));
  const files = [...Object.keys(manifest.inputs), ...Object.keys(manifest.outputs),
    'assets/icon-manifest.json', 'scripts/check-icons.cjs'];
  for (const name of files) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.copyFileSync(name, path.join(root, name));
  }
  const invoke = () => spawnSync(process.execPath, [path.join(root, 'scripts/check-icons.cjs')], { encoding: 'utf8' });
  const replace = (name: string, bytes: Buffer) => {
    fs.writeFileSync(path.join(root, name), bytes);
    manifest.outputs[name] = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(root, 'assets/icon-manifest.json'), JSON.stringify(manifest));
  };
  return { root, invoke, replace };
}

it('accepts the reviewed full-size resources and the required Windows and Retina size ladders', () => {
  const f = fixture(), result = f.invoke();
  expect(result.status).toBe(0);
  const proof = JSON.parse(result.stdout);
  expect(proof.icoSizes).toEqual(expect.arrayContaining([16, 24, 32, 48, 64, 128, 256]));
  expect(Object.values(proof.icnsSizes)).toContain(1024);
});

it('rejects stale generated icons after a master changes', () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.root, 'redactera-icon-sources/redactera-windows-cutout.png'), 'changed');
  expect(f.invoke().stderr).toContain('changed; run npm run icons:generate');
});

it('rejects a wrong ICO size even when its file digest was updated', () => {
  const f = fixture(), bytes = fs.readFileSync(path.join(f.root, 'assets/icon.ico'));
  bytes[6] = 48;
  f.replace('assets/icon.ico', bytes);
  expect(f.invoke().stderr).toContain('wrong ICO frame table');
});

it('rejects an ICNS missing the 1024 Retina image', () => {
  const f = fixture(), original = fs.readFileSync(path.join(f.root, 'assets/icon.icns'));
  let offset = 8;
  while (original.toString('ascii', offset, offset + 4) !== 'ic10') offset += original.readUInt32BE(offset + 4);
  const bytes = Buffer.from(original.subarray(0, offset));
  bytes.writeUInt32BE(bytes.length, 4);
  f.replace('assets/icon.icns', bytes);
  expect(f.invoke().stderr).toContain('missing ICNS Retina sizes');
});

it('rejects a corrupt RGBA PNG even when its file digest was updated', () => {
  const f = fixture(), bytes = fs.readFileSync(path.join(f.root, 'assets/redactera-macos.png'));
  bytes[29] ^= 1;
  f.replace('assets/redactera-macos.png', bytes);
  expect(f.invoke().stderr).toContain('PNG checksum mismatch');
});

it('rejects a missing branded installer animation', () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.root, 'assets/installer.gif'));
  expect(f.invoke().status).toBe(1);
});
