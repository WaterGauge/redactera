// Read-only prerequisite check. Does not import certificates, sign or contact Apple.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const report = { platform: process.platform, developerIdIdentityCount: 0, selectedIdentityInstalled: false,
  notarytoolAvailable: false, keychainProfileNameConfigured: Boolean(process.env.PDF_MAC_NOTARY_PROFILE),
  credentialsValidated: false, signingOrUploadPerformed: false, readyForSigningTrial: false,
  releaseVerified: false, remaining: ['Configure native backend signing before freezing', 'Configure normal Forge signing and notarization',
    'Verify signed nested binaries, app, DMG and stapled ticket', 'Validate on a separate clean Mac'] };
if (process.platform === 'darwin') {
  const identities = cp.spawnSync('/usr/bin/security', ['find-identity', '-p', 'codesigning', '-v'], { encoding: 'utf8', timeout: 10000 });
  const matches = [...(identities.stdout || '').matchAll(/\b([A-Fa-f0-9]{40})\s+"Developer ID Application:/g)].map(match => match[1].toUpperCase());
  report.developerIdIdentityCount = matches.length;
  const selected = process.env.PDF_MAC_SIGN_IDENTITY || '';
  report.selectedIdentityInstalled = /^[A-Fa-f0-9]{40}$/.test(selected) && matches.includes(selected.toUpperCase());
  const tool = cp.spawnSync('/usr/bin/xcrun', ['--find', 'notarytool'], { encoding: 'utf8', timeout: 10000 });
  report.notarytoolAvailable = !tool.error && tool.status === 0 && fs.existsSync(tool.stdout.trim());
  report.readyForSigningTrial = report.selectedIdentityInstalled && report.notarytoolAvailable && report.keychainProfileNameConfigured;
}
report.guide = path.relative(root, path.join(root, 'docs/handbook/mac-signing-notarization.md'));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.readyForSigningTrial ? 0 : 2;
