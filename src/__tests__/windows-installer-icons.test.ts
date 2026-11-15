import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redactera-setup-icon-'));
  roots.push(root);
  const setup = path.join(root, 'Setup.exe');
  fs.copyFileSync('node_modules/electron-winstaller/vendor/Setup.exe', setup);
  const run = (code: string) => spawnSync(process.execPath, ['-e', code, setup], { cwd: process.cwd(), encoding: 'utf8' });
  return { root, setup, run };
}

it('rebrands native Setup groups while preserving executable code, non-icon resources and upstream files', () => {
  const f = fixture();
  const result = f.run(`(async()=>{
    const fs=require('node:fs'),crypto=require('node:crypto');
    const file='node_modules/electron-winstaller/vendor/Setup.exe';
    const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const before=hash();
    const proof=await require('./scripts/prepare-windows-icons.cjs').prepareWindowsInstallerIcons(process.argv[1],'assets/icon.ico');
    await require('./scripts/verify-windows-release.cjs').verifyIcon(process.argv[1]);
    console.log(JSON.stringify({upstreamUnchanged:before===hash(),proof}));
  })().catch(e=>{console.error(e);process.exitCode=1});`);
  expect(result.status, result.stderr).toBe(0);
  const resultProof = JSON.parse(result.stdout);
  expect(resultProof.upstreamUnchanged).toBe(true);
  expect(resultProof.proof.nonIconResourcesPreserved).toBe(true);
  expect(resultProof.proof.executableIdentity).toMatchObject({ machine: 0x14c });
  expect(resultProof.proof.executableIdentity.sections.map((section: { name: string }) => section.name)).toContain('.text');
  expect(resultProof.proof.groups).toEqual([
    { id: 107, lang: 1033, frames: 10 }, { id: 108, lang: 1033, frames: 10 },
  ]);
});

it('rejects a correct shell icon with default secondary groups, then repairs all groups', () => {
  const f = fixture();
  const result = f.run(`(async()=>{
    const fs=require('node:fs');
    const {NtExecutable,NtExecutableResource,Resource,Data}=await import('resedit');
    const file=process.argv[1],exe=NtExecutable.from(fs.readFileSync(file));
    const resources=NtExecutableResource.from(exe);
    const icons=Data.IconFile.from(fs.readFileSync('assets/icon.ico')).icons.map(i=>i.data);
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries,1,1033,icons);
    resources.outputResource(exe);fs.writeFileSync(file,Buffer.from(exe.generate()));
    const verify=require('./scripts/verify-windows-release.cjs').verifyIcon;
    let rejected=false;
    try{await verify(file);}catch(error){rejected=error.message.includes('Windows icon group 107');}
    if(!rejected)throw Error('Mixed default groups were accepted');
    const proof=await require('./scripts/prepare-windows-icons.cjs').prepareWindowsInstallerIcons(file,'assets/icon.ico');
    console.log(JSON.stringify({rejected,groups:await verify(file),proofGroups:proof.groups}));
  })().catch(e=>{console.error(e);process.exitCode=1});`);
  expect(result.status, result.stderr).toBe(0);
  const proof = JSON.parse(result.stdout);
  expect(proof.rejected).toBe(true); expect(proof.groups).toBe(3);
});

it('refuses to modify any installer carrying an Authenticode security directory', () => {
  const f = fixture();
  const original = fs.readFileSync(f.setup);
  const bytes = Buffer.concat([original, Buffer.from([8, 0, 0, 0, 0, 2, 2, 0])]);
  const optional = bytes.readUInt32LE(0x3c) + 24;
  const directory = optional + (bytes.readUInt16LE(optional) === 0x10b ? 96 : 112) + 4 * 8;
  bytes.writeUInt32LE(original.length, directory); bytes.writeUInt32LE(8, directory + 4);
  fs.writeFileSync(f.setup, bytes);
  const result = f.run(`require('./scripts/prepare-windows-icons.cjs').prepareWindowsInstallerIcons(process.argv[1],'assets/icon.ico')
    .then(()=>{process.exitCode=2}).catch(error=>console.log(error.message));`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('requires an unsigned PE');
  expect(fs.readFileSync(f.setup)).toEqual(bytes);
});
