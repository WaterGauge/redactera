'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareRelease, targetPath, selectVerifiedTarget } = require('./trusted-update-policy.cjs');
const context = { channel: 'github', platform: 'win32', arch: 'x64', currentVersion: '2.0.0', allowPrerelease: false };
const info = (changes = {}) => ({ path: targetPath('win32', 'x64', '2.1.0'), length: 123, hashes: { sha256: 'a'.repeat(64) },
  custom: { schema: 1, channel: 'github', platform: 'win32', arch: 'x64', kind: 'full-installer', version: '2.1.0' }, ...changes });
test('stable full Windows installer', () => {
  const result = selectVerifiedTarget(info(), context);
  assert.deepEqual(result, { path: info().path, version: '2.1.0', length: 123, sha256: 'a'.repeat(64) });
  assert(Object.isFrozen(result));
});
test('native Mac installer', () => {
  const target = info({ path: targetPath('darwin', 'arm64', '2.1.0'), custom: { ...info().custom, platform: 'darwin', arch: 'arm64' } });
  assert.equal(selectVerifiedTarget(target, { ...context, platform: 'darwin', arch: 'arm64' }).version, '2.1.0');
});
for (const [a,b] of [['2.1.0','2.0.99'], ['2.1.0','2.1.0-rc.99'], ['2.1.0-rc.1','2.1.0-beta.999'], ['2.1.0-beta.10','2.1.0-beta.2'], ['2.1.0-beta.1','2.1.0-alpha.9'], ['2.9007199254740993.0','2.9007199254740992.0']]) {
  test(`release order ${a} > ${b}`, () => { assert.equal(compareRelease(a,b),1); assert.equal(compareRelease(b,a),-1); assert.equal(compareRelease(a,a),0); });
}
for (const [label, changes] of Object.entries({ store: { channel: 'store' }, unknown: { channel: undefined }, linux: { platform: 'linux' }, wrongArch: { arch: 'arm64' }, invalidCurrent: { currentVersion: '2.0' }, invalidConsent: { allowPrerelease: 'true' }, equal: { currentVersion: '2.1.0' }, rollback: { currentVersion: '2.2.0' } })) {
  test(`reject context ${label}`, () => assert.throws(() => selectVerifiedTarget(info(), { ...context, ...changes })));
}
for (const [label, changes] of Object.entries({ schema: { schema: 2 }, store: { channel: 'store' }, mac: { platform: 'darwin' }, arch: { arch: 'arm64' }, delta: { kind: 'delta' }, invalidVersion: { version: '02.1.0' }, metadataVersion: { version: '2.1.0+build' }, prerelease: { version: '2.1.0-rc.1' } })) {
  test(`reject signed custom identity ${label}`, () => assert.throws(() => selectVerifiedTarget(info({ custom: { ...info().custom, ...changes } }), context)));
}
for (const [label, changes] of Object.entries({ noCustom: { custom: undefined }, path: { path: '../Redactera.exe' }, url: { path: 'https://example.invalid/Redactera.exe' }, encoded: { path: 'github/win32-x64/%52edactera-2.1.0-Setup.exe' }, wrongName: { path: 'github/win32-x64/Redactera-2.2.0-Setup.exe' }, zero: { length: 0 }, negative: { length: -1 }, fractional: { length: 1.5 }, huge: { length: Number.MAX_SAFE_INTEGER + 1 }, noHash: { hashes: {} }, invalidHash: { hashes: { sha256: 'z'.repeat(64) } }, shortHash: { hashes: { sha256: 'a' } } })) {
  test(`reject malformed target ${label}`, () => assert.throws(() => selectVerifiedTarget(info(changes), context)));
}
test('prerelease only with explicit consent and newer version', () => {
  const version = '2.1.0-rc.1';
  const target = info({ path: targetPath('win32','x64',version), custom: { ...info().custom, version } });
  assert.throws(() => selectVerifiedTarget(target, context));
  assert.equal(selectVerifiedTarget(target, { ...context, allowPrerelease: true }).version, version);
  assert.throws(() => selectVerifiedTarget(target, { ...context, currentVersion: '2.1.0', allowPrerelease: true }));
});
