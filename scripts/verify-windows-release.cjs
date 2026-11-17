// Check a normal Windows package and the installer that actually ships it.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const extractZip = require('extract-zip');
const yauzl = createRequire(require.resolve('extract-zip'))('yauzl');
const { verifyPackage } = require('./backend-contract.cjs');
const { verifyWindowsPayload, verifySquirrelPayload } = require('./application-payload.cjs');
const { verifyIcons } = require('./check-icons.cjs');
const { verifyPackageNotices } = require('./package-notices.cjs');
const { executableIdentity } = require('./prepare-windows-icons.cjs');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const hash = bytes => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const hashFile = file => hash(fs.readFileSync(file));
const installerSources = path.join(__dirname, 'windows-installer');

function installerEvidencePath(setupSha256) {
  return path.join(root, '.project-state/windows-installer/evidence', setupSha256 + '.json');
}

function verifyBuildProof(build) {
  const lock = path.join(installerSources, 'lock.json');
  const expected = require(lock);
  const launcher = build?.launcher;
  if (build?.framework !== 'net45' || build.sdkVersion !== expected.sdk.version ||
      build.lockSha256 !== hashFile(lock) ||
      build.patchSha256 !== hashFile(path.join(installerSources, 'squirrel-full-only.patch')) ||
      !/^[a-f0-9]{64}$/.test(build.updaterSha256) ||
      launcher?.upstreamCommit !== expected.launcher.upstreamCommit ||
      launcher.windowsSdkVersion !== expected.launcher.windowsSdkVersion ||
      launcher.platformToolset !== expected.launcher.platformToolset ||
      !/^(17|18)(\.\d+){3}$/.test(launcher.visualStudioVersion) ||
      !/^\d+\.\d+\.\d+$/.test(launcher.vcToolsVersion) ||
      !launcher.vcToolsVersion.startsWith(expected.launcher.vcToolsVersionPrefix + '.') ||
      launcher.patchSha256 !== hashFile(path.join(installerSources, 'squirrel-launcher.patch')) ||
      !/^[a-f0-9]{64}$/.test(launcher.templateSha256)) {
    throw Error('Windows installer build evidence differs from the current updater inputs.');
  }
  return build;
}

// Check both views of the same archive before extraction. The raw pass rejects
// alternative names and special types; the decoded pass uses the actual
// extractor's yauzl semantics (including its CP437/UTF-8 decoding).
function scanZip(bytes, decodeStrings, visit) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      const fail = reason => { zip.close(); reject(reason); };
      zip.once('error', fail);
      zip.once('end', () => { zip.close(); resolve(entries); });
      zip.on('entry', entry => {
        try { entries.push(visit(entry)); }
        catch (error) { return fail(error); }
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

function entryIdentity(entry, name = entry.fileName) {
  return { name, attributes: entry.externalFileAttributes, creator: entry.versionMadeBy,
    size: entry.uncompressedSize, crc32: entry.crc32, flags: entry.generalPurposeBitFlag,
    compression: entry.compressionMethod, offset: entry.relativeOffsetOfLocalHeader };
}

async function verifyZipEntries(bytes, { fullPackage = false, expectedNames } = {}) {
  const paths = new Map();
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const raw = await scanZip(bytes, false, entry => {
    if (entry.fileName.includes(0x5c)) throw Error('Windows full package contains a backslash in a ZIP entry name.');
    if (!(entry.generalPurposeBitFlag & 0x800) && entry.fileName.some(byte => byte < 0x20 || byte >= 0x7f)) {
      throw Error('Windows full package has a non-ASCII ZIP entry without UTF-8 encoding.');
    }
    if (entry.extraFields.some(field => field.id === 0x7075)) {
      throw Error('Windows full package contains an alternative Unicode ZIP path.');
    }
    const name = utf8.decode(entry.fileName);
    const directory = name.endsWith('/');
    const parts = (directory ? name.slice(0, -1) : name).split('/');
    if (name.startsWith('__MACOSX/') || parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f\x7f]/.test(part) ||
        /[ .]$/.test(part) || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(part.split('.')[0].trimEnd()))) {
      throw Error('Windows full package contains an invalid or skipped path.');
    }
    // extract-zip interprets the high mode bits for every creator, not only
    // Unix. A DOS directory attribute must also agree with the trailing slash.
    const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
    const dosDirectory = Boolean(entry.externalFileAttributes & 0x10);
    if ((kind !== 0 && kind !== (directory ? 0x4000 : 0x8000)) ||
        (dosDirectory && !directory) || (directory && entry.uncompressedSize !== 0)) {
      throw Error('Windows full package contains a non-regular entry or inconsistent directory.');
    }
    for (let i = 0; i < parts.length; i++) {
      const spelling = parts.slice(0, i + 1).join('/');
      const key = spelling.toLowerCase();
      const explicit = i === parts.length - 1;
      const isDirectory = !explicit || directory;
      const previous = paths.get(key);
      if (previous && (previous.spelling !== spelling || previous.directory !== isDirectory || explicit && previous.explicit)) {
        throw Error('Windows full package contains duplicate or conflicting paths.');
      }
      paths.set(key, { spelling, directory: isDirectory, explicit: explicit || Boolean(previous?.explicit) });
    }
    return entryIdentity(entry, name);
  });
  const decoded = await scanZip(bytes, true, entry => entryIdentity(entry));
  if (JSON.stringify(raw) !== JSON.stringify(decoded)) throw Error('Windows full package decoded entries differ from raw entries.');
  const names = raw.map(entry => entry.name);
  if (fullPackage && names.filter(name => name === '_rels/.rels').length !== 1) {
    throw Error('Windows full package must contain exactly one _rels/.rels entry.');
  }
  if (expectedNames && JSON.stringify([...names].sort()) !== JSON.stringify([...expectedNames].sort())) {
    throw Error('Setup must contain a single full package.');
  }
  return raw;
}

async function verifyFullPackageEntries(bytes) {
  return (await verifyZipEntries(bytes, { fullPackage: true })).length;
}

async function extractCheckedZip(archive, output, bytes, options) {
  // Both callers use a private, quiescent archive written/read in the current
  // verification. Compare the actual extractor's entries to the preflight.
  const expected = await verifyZipEntries(bytes, options);
  let index = 0;
  await extractZip(archive, { dir: output, onEntry: entry => {
    if (JSON.stringify(entryIdentity(entry)) !== JSON.stringify(expected[index++])) {
      throw Error('Windows full package extraction entries differ from verified entries.');
    }
  } });
  if (index !== expected.length) throw Error('Windows full package extraction omitted verified entries.');
  return index;
}

async function extractSetup(setup, work, member) {
  const { NtExecutable, NtExecutableResource } = await import('resedit');
  const image = NtExecutable.from(fs.readFileSync(setup), { ignoreCert: true });
  const payload = NtExecutableResource.from(image).entries.filter(entry => entry.type === 'DATA' && entry.id === 131);
  if (payload.length !== 1) throw Error('Setup must contain exactly one installer archive.');
  const archive = path.join(work, 'setup.zip');
  fs.writeFileSync(archive, new Uint8Array(payload[0].bin), { flag: 'wx' });
  const output = path.join(work, 'setup');
  const expectedNames = ['RELEASES', 'Update.exe', 'background.gif', member, 'setupIcon.ico'];
  await extractCheckedZip(archive, output, fs.readFileSync(archive), { expectedNames });
  return output;
}

async function verifyIcon(file) {
  const { NtExecutable, NtExecutableResource, Resource } = await import('resedit');
  const resources = NtExecutableResource.from(NtExecutable.from(fs.readFileSync(file), { ignoreCert: true })).entries;
  const groups = Resource.IconGroupEntry.fromEntries(resources);
  if (!groups.length) throw Error('Windows executable has no icon groups: ' + path.basename(file));
  const ico = fs.readFileSync(path.join(root, 'assets/icon.ico'));
  const expected = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const header = 6 + index * 16;
    const start = ico.readUInt32LE(header + 12);
    return hash(ico.subarray(start, start + ico.readUInt32LE(header + 8)));
  }).sort();
  for (const group of groups) {
    const actual = group.icons.map(icon => {
      const entry = resources.find(item => item.type === 3 && item.id === icon.iconID && item.lang === group.lang);
      return entry ? hash(entry.bin) : '';
    }).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw Error('Windows icon group ' + group.id + ' does not match the project: ' + path.basename(file));
    }
  }
  return groups.length;
}

async function verify(output, setup, prepared, launcherTemplate) {
  verifyIcons(root);
  const evidence = await verifyPackage(root, output, 'win32', 'x64', 'normal', false);
  const applicationPayloadSha256 = verifyWindowsPayload(root, output, evidence).payloadSha256;
  if (path.basename(setup) !== pkg.branding.name + '-' + pkg.version + ' Setup.exe') throw Error('Installer filename does not match this version');
  const before = hashFile(setup);
  const recorded = prepared == null ? JSON.parse(fs.readFileSync(installerEvidencePath(before), 'utf8')) : null;
  if (recorded && recorded.applicationPayloadSha256 !== applicationPayloadSha256) {
    throw Error('Installer evidence refers to a different common application payload.');
  }
  const windowsInstaller = verifyBuildProof(prepared ?? recorded?.windowsInstaller);
  const { NtExecutable } = await import('resedit');
  const finalLauncher = executableIdentity(NtExecutable.from(fs.readFileSync(setup), { ignoreCert: true }));
  let expectedLauncher = recorded?.launcherIdentity;
  if (!recorded) {
    const template = fs.readFileSync(launcherTemplate);
    if (hash(template) !== windowsInstaller.launcher.templateSha256) throw Error('Native Setup template changed after building.');
    expectedLauncher = executableIdentity(NtExecutable.from(template));
  }
  if (finalLauncher.machine !== 0x14c || !finalLauncher.entryPoint ||
      JSON.stringify(finalLauncher) !== JSON.stringify(expectedLauncher)) {
    throw Error('Installer native code and data differ from the verified Setup template.');
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'redactera-setup-check-'));
  try {
    const version = pkg.version.replace(/-(alpha|beta|rc)\.(\d+)$/, '-$1$2');
    const member = pkg.installIdentity.squirrelName + '-' + version + '-full.nupkg';
    const outer = await extractSetup(setup, work, member);
    const archive = path.join(outer, member);
    const release = /^([a-f0-9]{40}) ([^\s]+) ([1-9][0-9]*)$/i.exec(
      fs.readFileSync(path.join(outer, 'RELEASES'), 'utf8').trim());
    const packageBytes = fs.readFileSync(archive);
    if (!release || release[2] !== member || release[3] !== String(packageBytes.length) ||
        release[1].toLowerCase() !== crypto.createHash('sha1').update(packageBytes).digest('hex')) {
      throw Error('Setup release manifest differs from its full package.');
    }
    const fullPackageSha256 = hash(packageBytes);
    // The managed maker opens the completed full package with NuGet before publishing it.
    const checkedPackageSha256 = recorded
      ? (recorded.nugetManifestVerified === true ? recorded.fullPackageSha256 : null)
      : hashFile(path.join(path.dirname(setup), member));
    if (fullPackageSha256 !== checkedPackageSha256) throw Error('Setup differs from the full package checked by NuGet.');
    for (const [file, asset] of [['background.gif', 'installer.gif'], ['setupIcon.ico', 'icon.ico']]) {
      if (!fs.readFileSync(path.join(outer, file)).equals(fs.readFileSync(path.join(root, 'assets', asset)))) {
        throw Error('Installer resource differs from the project: ' + file);
      }
    }
    const unpacked = path.join(work, 'unpacked');
    const rawZipEntries = await extractCheckedZip(archive, unpacked, packageBytes, { fullPackage: true });
    const spec = fs.readdirSync(unpacked).filter(name => name.endsWith('.nuspec'));
    if (spec.length !== 1) throw Error('Installer package metadata is missing');
    const xml = fs.readFileSync(path.join(unpacked, spec[0]), 'utf8');
    for (const [key, value] of [['id', pkg.installIdentity.squirrelName], ['version', version], ['title', pkg.branding.nameZh]]) {
      if (!xml.includes('<' + key + '>' + value + '</' + key + '>')) throw Error('Installer metadata does not match: ' + key);
    }
    const payload = path.join(unpacked, 'lib/net45');
    if (hashFile(path.join(outer, 'Update.exe')) !== windowsInstaller.updaterSha256 ||
        hashFile(path.join(payload, 'Squirrel.exe')) !== windowsInstaller.updaterSha256) {
      throw Error('Setup and the application must embed the updater from the current Windows build.');
    }
    verifyPackageNotices(root, path.join(payload, 'resources'), 'win32');
    const embedded = verifySquirrelPayload(root, output, evidence, payload);
    if (embedded.payloadSha256 !== applicationPayloadSha256) throw Error('Installer application receipt changed during verification.');
    if (recorded && JSON.stringify(recorded.embeddedFiles) !== JSON.stringify(embedded.embeddedFiles)) {
      throw Error('Installer embedded file evidence has changed.');
    }
    let iconGroups = 0;
    for (const file of [setup, path.join(output, 'Redactera.exe'), path.join(payload, 'Squirrel.exe'),
      path.join(payload, 'Redactera_ExecutionStub.exe')]) iconGroups += await verifyIcon(file);
    if (hashFile(setup) !== before) throw Error('Installer changed during verification');
    if (verifyWindowsPayload(root, output, evidence).payloadSha256 !== applicationPayloadSha256) {
      throw Error('Application payload changed during installer verification.');
    }
    return { verified: true, installerSha256: before, applicationSourceSha256: evidence.appBuild.applicationSourceSha256,
      asarSha256: evidence.asarSha256, applicationPayloadSha256, embeddedFiles: embedded.embeddedFiles, projectIconsVerified: 4, projectIconGroupsVerified: iconGroups,
      installerAnimationVerified: true, fullPackageSha256, rawZipEntries, nugetManifestVerified: true,
      launcherIdentity: finalLauncher, windowsInstaller };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
module.exports = { verify, verifyIcon, installerEvidencePath, verifyFullPackageEntries, extractCheckedZip };
if (require.main === module) {
  const output = process.argv[2] || path.join(root, 'out/Redactera-win32-x64');
  const setup = process.argv[3] || path.join(root, 'out/make/squirrel.windows/x64', pkg.branding.name + '-' + pkg.version + ' Setup.exe');
  verify(output, setup).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
