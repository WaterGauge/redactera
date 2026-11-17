'use strict';

// This is application policy, not a TUF verifier. Call only with target
// information obtained from a verified, freshly refreshed TUF client.
// No network access, installation or production signing keys are provided here.
const { assertReleaseVersion } = require('./release-version.cjs');

function compareRelease(a, b) {
  const parts = version => {
    const [core, pre] = assertReleaseVersion(version).split('-');
    const [name, number] = pre ? pre.split('.') : ['release', '0'];
    return [...core.split('.').map(BigInt), BigInt(['alpha', 'beta', 'rc', 'release'].indexOf(name)), BigInt(number)];
  };
  const left = parts(a), right = parts(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function targetPath(platform, arch, version) {
  assertReleaseVersion(version);
  if (platform === 'win32' && arch === 'x64') return `github/win32-x64/Redactera-${version}-Setup.exe`;
  if (platform === 'darwin' && arch === 'arm64') return `github/darwin-arm64/Redactera-${version}-arm64.dmg`;
  throw Error('Unsupported update platform or architecture');
}

function selectVerifiedTarget(info, context) {
  if (!context || context.channel !== 'github' || typeof context.allowPrerelease !== 'boolean') {
    throw Error('Unsupported update channel or policy');
  }
  assertReleaseVersion(context.currentVersion);
  // Only the two current native release targets are supported by this policy.
  targetPath(context.platform, context.arch, context.currentVersion);
  const custom = info?.custom;
  if (!custom || typeof custom !== 'object' || Array.isArray(custom) || custom.schema !== 1 ||
      custom.channel !== context.channel || custom.platform !== context.platform || custom.arch !== context.arch ||
      custom.kind !== 'full-installer') throw Error('Target identity does not match this application');
  const version = assertReleaseVersion(custom.version);
  if (!context.allowPrerelease && version.includes('-')) throw Error('Prerelease updates are not enabled');
  if (compareRelease(version, context.currentVersion) <= 0) throw Error('Target is not newer than the installed release');
  if (info.path !== targetPath(context.platform, context.arch, version)) throw Error('Unexpected target path');
  if (!Number.isSafeInteger(info.length) || info.length <= 0 || !info.hashes ||
      typeof info.hashes.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(info.hashes.sha256)) {
    throw Error('Target length or SHA-256 is invalid');
  }
  // This descriptor is neither an install authorization nor a verified local file.
  return Object.freeze({ path: info.path, version, length: info.length, sha256: info.hashes.sha256 });
}

module.exports = { compareRelease, targetPath, selectVerifiedTarget };
