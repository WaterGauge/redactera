// Local preparation only. Never invokes GitHub or starts an installer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyReleaseVersion } = require('./release-version.cjs');
const { applicationSource } = require('./backend-contract.cjs');

function installerFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error('Installer artifacts must not contain symbolic links');
    if (entry.isDirectory()) return installerFiles(file);
    if (!entry.isFile()) throw Error('Installer artifacts must be regular files');
    return [file];
  });
}

function prepare(input, output, root, ref) {
  input = path.resolve(input); output = path.resolve(output);
  const git = args => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8' }).trim();
  const { version } = verifyReleaseVersion(root, ref);
  const commit = git(['rev-parse', '--verify', ref + '^{commit}']);
  if (git(['rev-parse', 'HEAD']) !== commit || git(['status', '--porcelain', '--untracked-files=no'])) {
    throw Error('Release assets require a clean tracked checkout of the tagged commit');
  }
  applicationSource(root, commit);
  git(['cat-file', '-e', commit + ':LICENSE']);
  if (fs.existsSync(output)) throw Error('The release output directory must not already exist');
  const files = ['macOS', 'Windows'].map(platform => {
    const directory = path.join(input, platform);
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw Error('A real artifact directory is required for each platform');
    const found = installerFiles(directory);
    if (found.length !== 1 || !fs.statSync(found[0]).size ||
        !(platform === 'macOS' ? found[0].endsWith('.dmg') : found[0].endsWith('Setup.exe'))) {
      throw Error('Exactly one nonempty installer is required for ' + platform);
    }
    const name = path.basename(found[0]);
    if (/[\r\n\\]/.test(name)) throw Error('Installer names must be valid checksum filenames');
    return { source: found[0], name };
  });
  const upstream = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'release-upstream.json'), 'utf8'));
  const requirements = fs.readFileSync(path.join(root, 'python-backend', 'requirements.txt'), 'utf8').split(/\r?\n/);
  if (!requirements.includes('PyMuPDF==' + upstream.pymupdfVersion)) {
    throw Error('Update the corresponding source records for the pinned PyMuPDF version');
  }
  const sourceDirectory = path.join(input, 'upstream');
  const sourceFiles = upstream.archives.map(({ name, sha256 }) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]*\.tar\.(?:gz|xz)$/.test(name) || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw Error('Invalid upstream source record');
    }
    const source = path.join(sourceDirectory, name);
    if (!fs.lstatSync(source, { throwIfNoEntry: false })?.isFile()) throw Error('Missing upstream source: ' + name);
    return { source, name, sha256 };
  });
  const attachments = [...files, ...sourceFiles];
  if (new Set(attachments.map(file => file.name)).size !== attachments.length) throw Error('Attachment names must be distinct');
  fs.mkdirSync(output);
  try {
    const lines = attachments.map(file => {
      const destination = path.join(output, file.name);
      fs.copyFileSync(file.source, destination, fs.constants.COPYFILE_EXCL);
      const digest = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
      if (file.sha256 && digest !== file.sha256) throw Error('Upstream source checksum mismatch: ' + file.name);
      return `${digest}  ${file.name}\n`;
    });
    const prefix = 'Redactera-' + version;
    const sourceArchive = path.join(output, prefix + '-source.tar.gz');
    git(['archive', '--format=tar.gz', '--prefix=' + prefix + '/', '--output=' + sourceArchive, commit]);
    const sourceDigest = crypto.createHash('sha256').update(fs.readFileSync(sourceArchive)).digest('hex');
    lines.push(`${sourceDigest}  ${path.basename(sourceArchive)}\n`);
    fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), lines.join(''), { flag: 'wx' });
    return [...attachments.map(file => path.join(output, file.name)), sourceArchive];
  } catch (error) {
    // This invocation created this exact directory; never clear an existing one.
    fs.rmSync(output, { recursive: true });
    throw error;
  }
}

module.exports = { prepare };
if (require.main === module) {
  if (process.argv.length !== 4) throw Error('Use prepare-release-assets.cjs INPUT_DIRECTORY NEW_OUTPUT_DIRECTORY');
  console.log(JSON.stringify({ prepared: prepare(process.argv[2], process.argv[3], path.resolve(__dirname, '..'), process.env.GITHUB_REF) }));
}
