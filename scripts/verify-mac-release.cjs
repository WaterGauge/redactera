// Read-only release gate. Never signs, imports keys, submits or publishes.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const { verifyPackage } = require('./backend-contract.cjs');
const { directorySnapshot } = require('../e2e/support/evidence.cjs');
const { verifyIcons } = require('./check-icons.cjs');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const command = (file, args) => cp.spawnSync(file, args, { encoding: 'utf8', timeout: 30000 });
function signature(file) {
  const checked = command('/usr/bin/codesign', ['--verify', '--deep', '--strict', file]);
  const details = command('/usr/bin/codesign', ['--display', '--verbose=4', file]);
  const text = details.stderr || '';
  return { verified: !checked.error && checked.status === 0 && !details.error && details.status === 0,
    developerId: /^Authority=Developer ID Application:/m.test(text), adHoc: /^Signature=adhoc$/m.test(text),
    team: /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(text)?.[1] || '', hardenedRuntime: /flags=.*\bruntime\b/.test(text) };
}
function nativeFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...nativeFiles(file));
    else if (entry.isFile()) {
      const fd = fs.openSync(file, 'r'); const prefix = Buffer.alloc(4);
      try { fs.readSync(fd, prefix, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca', 'feedfacf', 'feedface'].includes(prefix.toString('hex'))) result.push(file);
    }
  }
  return result;
}
async function verify(app, dmg, mode = 'manual') {
  verifyIcons(root);
  const report = { platform: process.platform, artifactReleaseChecksPassed: false, signingOrUploadPerformed: false,
    distributionMode: mode, developerIdAndNotarizationRequired: mode === 'notarized', notarizationChecked: false,
    manualFirstLaunchInstructionsRequired: mode === 'manual', cleanSystemAcceptanceChecked: false,
    expectedElectron: pkg.devDependencies.electron, blockers: [], binaries: [] };
  if (!['manual', 'notarized'].includes(mode)) { report.blockers.push('Unknown Mac distribution mode'); return report; }
  if (process.platform !== 'darwin') { report.blockers.push('Native macOS is required'); return report; }
  try {
    if (!path.isAbsolute(app) || path.basename(app) !== `${pkg.branding.name}.app` || !fs.statSync(app).isDirectory()) throw Error('An absolute normal app bundle is required');
    const evidence = await verifyPackage(root, path.dirname(app), 'darwin', process.arch, 'normal', false);
    report.appVersion = evidence.appBuild.contract.appVersion; report.asarSha256 = evidence.asarSha256;
    const plist = path.join(app, 'Contents/Frameworks/Electron Framework.framework/Resources/Info.plist');
    const runtime = command('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', plist]);
    if (runtime.error || runtime.status !== 0) throw Error('Cannot read the packaged Electron version');
    report.packagedElectron = runtime.stdout.trim();
    if (report.packagedElectron !== report.expectedElectron) report.blockers.push('Packaged Electron does not match the pinned source dependency');
    const outer = signature(app); report.appSignature = outer;
    if (!outer.verified) report.blockers.push('A valid local app signature is required in every distribution mode');
    if (mode === 'notarized' && (!outer.developerId || outer.adHoc || !outer.team || !outer.hardenedRuntime)) {
      report.blockers.push('A valid Developer ID app signature with hardened runtime is required; local ad hoc is insufficient');
    }
    for (const file of nativeFiles(path.join(app, 'Contents'))) {
      const info = signature(file);
      const executable = file.includes(path.sep + 'MacOS' + path.sep) || file === path.join(evidence.resources, 'dist/python_backend');
      report.binaries.push({ file: path.relative(app, file), executable, ...info });
      if (!info.verified) report.blockers.push('Native component signature is invalid: ' + path.relative(app, file));
      if (mode === 'notarized' && (!info.developerId || info.adHoc || !info.team || info.team !== outer.team || executable && !info.hardenedRuntime)) {
        report.blockers.push('Native component needs consistent Developer ID signing, and executables need hardened runtime: ' + path.relative(app, file));
      }
    }
    if (!report.binaries.length) report.blockers.push('No native components were inspected');
    if (!path.isAbsolute(dmg) || !fs.statSync(dmg).isFile()) throw Error('An absolute final DMG is required');
    report.dmgSha256 = hash(dmg);
    // Both modes verify the actual DMG. Only the explicitly requested paid
    // distribution mode requires Apple notarization and Gatekeeper assessment.
    if (!report.blockers.length) {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-release-inspect-'));
      const mount = path.join(temporary, 'volume'); fs.mkdirSync(mount);
      let mounted = false;
      try {
        const attached = command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
        if (attached.error || attached.status !== 0) throw Error('Cannot inspect the DMG read-only');
        mounted = true;
        const contained = path.join(mount, path.basename(app));
        const expected = directorySnapshot(app).sha256;
        const actual = directorySnapshot(contained).sha256;
        if (actual !== expected || !signature(contained).verified) throw Error('The DMG contains a different or invalid app');
        report.containedAppTreeSha256 = actual;
        const volumeIcon = path.join(mount, '.VolumeIcon.icns');
        if (!fs.lstatSync(volumeIcon, { throwIfNoEntry: false })?.isFile() ||
            hash(volumeIcon) !== hash(path.join(root, 'assets', 'icon.icns'))) {
          throw Error('The DMG volume does not carry the project icon');
        }
        const finder = command('/usr/bin/xattr', ['-px', 'com.apple.FinderInfo', mount]);
        const finderInfo = Buffer.from((finder.stdout || '').replace(/\s/g, ''), 'hex');
        if (finder.error || finder.status !== 0 || finderInfo.length !== 32 || !(finderInfo.readUInt16BE(8) & 0x0400)) {
          throw Error('The DMG volume custom icon flag is missing');
        }
        report.volumeIconSha256 = hash(volumeIcon);
      } finally {
        if (mounted) {
          const detached = command('/usr/bin/hdiutil', ['detach', mount]);
          if (detached.error || detached.status !== 0) report.blockers.push('Read-only release volume could not be detached');
          else mounted = false;
        }
        if (!mounted) fs.rmSync(temporary, { recursive: true });
      }
      if (mode === 'notarized') {
        report.notarizationChecked = true;
        for (const [label, file, args] of [
          ['App staple', '/usr/bin/xcrun', ['stapler', 'validate', app]],
          ['DMG staple', '/usr/bin/xcrun', ['stapler', 'validate', dmg]],
          ['App Gatekeeper', '/usr/sbin/spctl', ['--assess', '--type', 'execute', app]],
          ['DMG Gatekeeper', '/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', dmg]],
        ]) {
          const checked = command(file, args);
          if (checked.error || checked.status !== 0) report.blockers.push(label + ' validation failed');
        }
      }
    }
  } catch (error) { report.blockers.push(error.message); }
  report.artifactReleaseChecksPassed = report.blockers.length === 0;
  return report;
}
module.exports = { verify };
if (require.main === module) {
  const args = process.argv.slice(2);
  let mode = 'manual';
  if (args[0] === '--notarized') { mode = 'notarized'; args.shift(); }
  else if (args[0] === '--manual') args.shift();
  if (args.length > 2 || args.some(arg => arg.startsWith('--'))) throw Error('Use [--manual|--notarized] [ABSOLUTE_APP ABSOLUTE_DMG]');
  const { name } = pkg.branding;
  const app = args[0] || path.join(root, 'out', `${name}-darwin-${process.arch}`, `${name}.app`);
  const dmg = args[1] || path.join(root, 'out/make/dmg', process.arch, `${name}-${pkg.version}-${process.arch}.dmg`);
  verify(app, dmg, mode).then(report => { console.log(JSON.stringify(report, null, 2)); process.exitCode = report.artifactReleaseChecksPassed ? 0 : 2; });
}
