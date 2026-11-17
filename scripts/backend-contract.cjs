const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { verifyPackageNotices } = require('./package-notices.cjs');
const pythonLicensesFile = 'python-licenses.zip';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function applicationSource(root) {
  const files = [];
  const collect = (directory, extensions) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file, extensions);
      else if (entry.isFile() && extensions.includes(path.extname(entry.name))) files.push(file);
    }
  };
  const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.json', '.css', '.html', '.py', '.svg'];
  for (const directory of ['src', 'e2e', 'scripts']) collect(path.join(root, directory), sourceExtensions);
  collect(path.join(root, 'scripts/windows-installer'), ['.patch', '.txt']);
  // The packagers consume the final platform files, not local iconset intermediates.
  const backend = path.join(root, 'python-backend');
  for (const name of fs.readdirSync(backend).filter(name => /^[^.].*\.(py|spec|txt|ini)$/.test(name))) files.push(path.join(backend, name));
  const configuration = ['package.json', 'package-lock.json', 'forge.config.ts', 'webpack.main.config.ts',
    'webpack.renderer.config.ts', 'webpack.rules.ts', 'webpack.plugins.ts', 'webpack.pdf-assets.ts',
    'tsconfig.json', 'tsconfig.e2e.json', 'tsconfig.build.json', 'LICENSE', 'CHANGELOG.md',
    'scripts/icon-requirements.txt', 'assets/icon.icns', 'assets/icon.ico', 'assets/icon-manifest.json',
    'assets/redactera-macos.png', 'assets/redactera-windows.png', 'assets/installer.gif',
    'redactera-icon-sources/redactera-macos-source.png', 'redactera-icon-sources/redactera-windows-source.png',
    'redactera-icon-sources/redactera-macos-cutout.png', 'redactera-icon-sources/redactera-windows-cutout.png'];
  for (const name of configuration) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) files.push(file);
  }
  const relative = files.map(file => path.relative(root, file).split(path.sep).join('/')).sort();
  const hashes = Object.fromEntries(relative.map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]));
  return { sha256: sha256(JSON.stringify(hashes)), files: hashes };
}

function contract(root) {
  const directory = path.join(root, 'python-backend');
  const files = Object.fromEntries(fs.readdirSync(directory).filter(name => /^[^.].*\.(py|spec|txt)$/.test(name)).sort()
    .map(name => [`python-backend/${name}`, sha256(fs.readFileSync(path.join(directory, name)))]));
  files['scripts/release-upstream.json'] = sha256(fs.readFileSync(path.join(root, 'scripts/release-upstream.json')));
  return { protocol: 1, appVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    sourceSha256: sha256(JSON.stringify(files)) };
}

function verifyPythonLicenses(directory, manifest) {
  const file = path.join(directory, pythonLicensesFile);
  const notice = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!notice?.isFile() || !notice.size || sha256(fs.readFileSync(file)) !== manifest.pythonLicensesSha256) {
    throw Error('Packaged Python licenses do not match this build.');
  }
}

function verify(root, platform = process.platform, arch = process.arch) {
  const directory = path.join(root, 'python-backend', 'dist');
  if (!fs.existsSync(path.join(directory, 'backend-manifest.json'))) throw Error('Backend build manifest is missing. Run npm run build:backend or the controlled package/make entry.');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'backend-manifest.json'), 'utf8'));
  const expected = contract(root);
  if (JSON.stringify(manifest.contract) !== JSON.stringify(expected) || manifest.platform !== platform || manifest.arch !== arch) {
    throw Error('Backend build is stale or targets a different platform. Run the controlled build entry.');
  }
  const executable = platform === 'win32' ? 'python_backend.exe' : 'python_backend';
  if (manifest.executable !== executable || fs.readdirSync(directory).sort().join('|') !== ['backend-manifest.json', executable, pythonLicensesFile].sort().join('|') ||
      sha256(fs.readFileSync(path.join(directory, executable))) !== manifest.executableSha256) {
    throw Error('Backend executable or resource manifest does not match this build.');
  }
  verifyPythonLicenses(directory, manifest);
  return manifest;
}
// Build inputs can contain machine paths; shipped resources use this fixed schema.
function runtimeManifest(manifest) {
  return { contract: manifest.contract, platform: manifest.platform, arch: manifest.arch,
    executable: manifest.executable, executableSha256: manifest.executableSha256, pythonLicensesSha256: manifest.pythonLicensesSha256 };
}
function preparePackageBackend(root, platform = process.platform, arch = process.arch) {
  const manifest = verify(root, platform, arch);
  const destination = path.join(root, '.project-state', 'app-build-input', 'dist');
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(destination)) {
    if (![manifest.executable, 'backend-manifest.json', pythonLicensesFile].includes(name)) {
      throw Error('Unexpected file in packaged backend staging directory.');
    }
  }
  for (const file of [manifest.executable, pythonLicensesFile]) {
    fs.copyFileSync(path.join(root, 'python-backend', 'dist', file), path.join(destination, file));
  }
  fs.writeFileSync(path.join(destination, 'backend-manifest.json'), JSON.stringify(runtimeManifest(manifest), null, 2));
}
function packagedAppName(pkg, platform, flavor) {
  if (flavor !== 'e2e') return pkg.branding.name;
  return pkg.branding.name + ' E2E';
}

function macBundleNames(branding, localization, flavor) {
  const language = path.basename(localization, '.lproj');
  const menuName = flavor === 'e2e' ? `${branding.nameZh}（测试版）` : branding.nameZh;
  const englishName = flavor === 'e2e' ? `${branding.name} (Test)` : branding.name;
  const displayName = /^zh(?:[-_]|$)/i.test(language) ? menuName : englishName;
  return `"CFBundleName" = ${JSON.stringify(menuName)};\n"CFBundleDisplayName" = ${JSON.stringify(displayName)};\n`;
}

async function verifyPackage(root, output, platform, arch, flavor, currentDist = true) {
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const appName = packagedAppName(expected, platform, flavor);
  const base = platform === 'darwin' ? path.join(output, `${appName}.app`) : output;
  const resources = platform === 'darwin' ? path.join(base, 'Contents', 'Resources') : path.join(base, 'resources');
  const asar = require('@electron/asar');
  const archive = path.join(resources, 'app.asar');
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  if (pkg.name !== expected.name || pkg.productName !== expected.productName ||
      pkg.branding?.name !== expected.branding.name || pkg.branding?.nameZh !== expected.branding.nameZh ||
      pkg.installIdentity?.macBundleId !== expected.installIdentity.macBundleId ||
      pkg.installIdentity?.squirrelName !== expected.installIdentity.squirrelName) {
    throw Error('Packaged application name or installation identity does not match the source.');
  }
  if (pkg.license !== expected.license) throw Error('Packaged project license metadata does not match the source.');
  const appBuild = JSON.parse(fs.readFileSync(path.join(resources, 'app-build.json'), 'utf8'));
  if (appBuild.schema !== 2 || appBuild.applicationSourceSha256 !== applicationSource(root).sha256) {
    throw Error('Packaged application source does not match the current source snapshot. Rebuild the application.');
  }
  const bundled = JSON.parse(fs.readFileSync(path.join(resources, 'dist', 'backend-manifest.json'), 'utf8'));
  if (JSON.stringify(bundled) !== JSON.stringify(runtimeManifest(bundled))) {
    throw Error('Packaged backend manifest contains build-only information.');
  }
  const manifest = currentDist ? verify(root, platform, arch) : bundled;
  if (JSON.stringify(manifest.contract) !== JSON.stringify(contract(root)) || manifest.platform !== platform || manifest.arch !== arch ||
      manifest.executable !== (platform === 'win32' ? 'python_backend.exe' : 'python_backend')) throw Error('Packaged backend is stale or targets another platform.');
  if (pkg.version !== manifest.contract.appVersion || appBuild.flavor !== flavor ||
      JSON.stringify(appBuild.contract) !== JSON.stringify(manifest.contract) || appBuild.backendSha256 !== manifest.executableSha256 ||
      JSON.stringify(bundled) !== JSON.stringify(runtimeManifest(manifest)) || sha256(fs.readFileSync(path.join(resources, 'dist', manifest.executable))) !== manifest.executableSha256) {
    throw Error('Packaged application and backend identities do not match.');
  }
  verifyPythonLicenses(path.join(resources, 'dist'), manifest);
  const files = asar.listPackage(archive).map(file => file.split(path.sep).join('/'));
  if (pkg.main !== '.webpack/main/index.cjs') throw Error('Packaged Main entry does not match the locked Forge format.');
  // ASAR lookup uses native separators; package.json keeps a portable Main path.
  const main = asar.extractFile(archive, path.normalize(pkg.main));
  if (main.includes(Buffer.from('__pdfE2E')) !== (flavor === 'e2e') ||
      main.includes(Buffer.from('use-mock-keychain')) !== (flavor === 'e2e') ||
      !main.includes(Buffer.from(manifest.contract.sourceSha256))) {
    throw Error('Packaged Main does not match the declared production/test build identity.');
  }
  for (const suffix of ['/.webpack/main/index.cjs', '/.webpack/renderer/main_window/index.html',
    '/.webpack/renderer/main_window/preload.cjs', '/.webpack/renderer/main_window/pdf-assets/pdf.worker.mjs',
    '/.webpack/renderer/main_window/pdf-assets/wasm/openjpeg.wasm']) {
    if (!files.includes(suffix)) throw Error(`Required packaged resource is missing: ${suffix}`);
  }
  for (const directory of ['/pdf-assets/cmaps/', '/pdf-assets/standard_fonts/', '/pdf-assets/iccs/']) {
    if (!files.some(file => file.includes(directory))) throw Error(`Required PDF resource directory is missing: ${directory}`);
  }
  verifyPackageNotices(root, resources, platform);
  if (platform === 'win32' &&
      !fs.readFileSync(path.join(resources, 'icon.ico')).equals(fs.readFileSync(path.join(root, 'assets/icon.ico')))) {
    throw Error('Packaged Windows window icon does not match the project.');
  }
  let macSigning;
  if (platform === 'darwin') {
    const plist = path.join(base, 'Contents', 'Info.plist');
    const bundleId = flavor === 'e2e' ? `${expected.installIdentity.macBundleId}-e2e` : expected.installIdentity.macBundleId;
    const readBundleString = key => {
      const result = cp.spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist],
        { encoding: 'utf8', timeout: 10000 });
      if (result.error || result.status !== 0) throw Error(`Cannot read packaged Mac ${key}.`);
      return result.stdout.trim();
    };
    for (const [key, value] of [['CFBundleIdentifier', bundleId], ['CFBundleExecutable', appName],
      ['CFBundleName', appName], ['CFBundleDisplayName', appName]]) {
      if (readBundleString(key) !== value) throw Error(`Packaged Mac ${key} does not match the expected identity.`);
    }
    const localizations = fs.readdirSync(resources).filter(name => name.endsWith('.lproj'));
    const required = ['Base.lproj', 'en.lproj', 'zh-Hans.lproj', 'zh-Hant.lproj'];
    if (required.some(name => !localizations.includes(name)) || localizations.some(name =>
      fs.readFileSync(path.join(resources, name, 'InfoPlist.strings'), 'utf8') !== macBundleNames(expected.branding, name, flavor))) {
      throw Error('Packaged Mac display names do not match the source.');
    }
    if (readBundleString('LSApplicationCategoryType') !== 'public.app-category.productivity') {
      throw Error('Packaged Mac application category does not match the product.');
    }
    const plistRead = cp.spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8', timeout: 10000 });
    if (plistRead.error || plistRead.status !== 0) throw Error('Cannot inspect Mac device usage declarations.');
    const properties = JSON.parse(plistRead.stdout);
    if (['NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription',
      'NSCameraUsageDescription', 'NSMicrophoneUsageDescription'].some(key => key in properties)) {
      throw Error('Packaged Mac application carries unused device usage declarations.');
    }
    const iconFile = readBundleString('CFBundleIconFile');
    if (!iconFile || path.basename(iconFile) !== iconFile ||
        !fs.readFileSync(path.join(resources, iconFile)).equals(fs.readFileSync(path.join(root, 'assets', 'icon.icns')))) {
      throw Error('Packaged Mac icon does not match the project icon.');
    }
    const verifySignature = (target, deep, label) => {
      const result = cp.spawnSync('/usr/bin/codesign', ['--verify', ...(deep ? ['--deep'] : []), '--strict', target],
        { encoding: 'utf8', timeout: 30000 });
      if (result.error || result.status !== 0) throw Error(`Mac ${label} signature verification failed; rebuild the final application before testing or making installers.`);
    };
    verifySignature(base, true, 'application');
    verifySignature(path.join(resources, 'dist', manifest.executable), false, 'backend');
    const details = cp.spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', base], { encoding: 'utf8', timeout: 10000 });
    if (details.error || details.status !== 0) throw Error('Cannot inspect the verified Mac signature.');
    macSigning = { appVerified: true, backendVerified: true, adHoc: /^Signature=adhoc$/m.test(details.stderr),
      developerId: /^Authority=Developer ID Application:/m.test(details.stderr) };
  }
  const { getCurrentFuseWire, FuseV1Options, FuseState } = await import('@electron/fuses');
  const binary = platform === 'darwin' ? path.join(base, 'Contents', 'MacOS', appName)
    : path.join(base, appName + '.exe');
  const fuses = await getCurrentFuseWire(binary);
  if (fuses[FuseV1Options.EnableNodeCliInspectArguments] !== (flavor === 'e2e' ? FuseState.ENABLE : FuseState.DISABLE) ||
      fuses[FuseV1Options.RunAsNode] !== FuseState.DISABLE || fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable] !== FuseState.DISABLE ||
      fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] !== FuseState.ENABLE || fuses[FuseV1Options.OnlyLoadAppFromAsar] !== FuseState.ENABLE) throw Error('Packaged Electron fuses do not match the declared build flavor.');
  return { binary, resources, appBuild, backendSha256: manifest.executableSha256,
    pythonLicensesSha256: manifest.pythonLicensesSha256, asarSha256: sha256(fs.readFileSync(archive)), fuses,
    ...(macSigning ? { macSigning } : {}) };
}
module.exports = { applicationSource, contract, verify, preparePackageBackend, verifyPackage, packagedAppName, macBundleNames };
