const fs = require('node:fs');
const path = require('node:path');
const installerNotices = 'scripts/windows-installer/notices';

const files = [
  ['electron', 'LICENSE'],
  ['electron', 'LICENSES.chromium.html'],
  ['pdfjs-dist', 'LICENSE'],
  ['react', 'LICENSE'],
  ['react-dom', 'LICENSE'],
  ['scheduler', 'LICENSE'],
  ['css-loader', 'LICENSE'],
  ['style-loader', 'LICENSE'],
  ['electron-squirrel-startup', 'LICENSE'],
  // Webpack bundles the resolved startup dependencies into Main. These are
  // nested in the current lockfile and are not the root debug/ms versions.
  ['debug', 'LICENSE', 'electron-squirrel-startup/node_modules/debug'],
  ['ms', 'license.md', 'electron-squirrel-startup/node_modules/ms'],
  ['@fontsource/dm-sans', 'LICENSE'],
  ['@fontsource/ibm-plex-sans', 'LICENSE'],
];

function stagePackageNotices(root, extractedRuntime, platform) {
  const resources = platform === 'darwin' || platform === 'mas'
    ? path.join(extractedRuntime, 'Electron.app', 'Contents', 'Resources')
    : path.join(extractedRuntime, 'resources');

  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(resources, 'LICENSE'), fs.constants.COPYFILE_EXCL);
  for (const [component, file, modulePath = component] of files) {
    const source = component === 'electron'
      ? path.join(extractedRuntime, file)
      : path.join(root, 'node_modules', modulePath, file);
    const destination = path.join(resources, 'third-party-licenses', component, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
  if (platform === 'win32') {
    fs.cpSync(path.join(root, installerNotices),
      path.join(resources, 'third-party-licenses/windows-installer'), { recursive: true, force: false, errorOnExist: true });
  }
  verifyPackageNotices(root, resources, platform);
}

function verifyPackageNotices(root, resources, platform) {
  const projectLicense = path.join(resources, 'LICENSE');
  if (!fs.existsSync(projectLicense) || !fs.readFileSync(projectLicense).equals(fs.readFileSync(path.join(root, 'LICENSE')))) {
    throw Error('Missing or changed packaged project license.');
  }
  for (const [component, file, modulePath = component] of files) {
    const destination = path.join(resources, 'third-party-licenses', component, file);
    const notice = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (!notice?.isFile() || notice.size === 0) throw Error('Missing or empty packaged license: ' + component + '/' + file);
    if (component !== 'electron' && !fs.readFileSync(destination).equals(fs.readFileSync(path.join(root, 'node_modules', modulePath, file)))) {
      throw Error('Changed packaged license: ' + component + '/' + file);
    }
  }
  if (platform === 'win32') {
    const source = path.join(root, installerNotices);
    const destination = path.join(resources, 'third-party-licenses/windows-installer');
    const expected = fs.readdirSync(source).sort();
    if (JSON.stringify(fs.readdirSync(destination).sort()) !== JSON.stringify(expected)) {
      throw Error('Packaged Windows installer notices differ from the project.');
    }
    for (const name of expected) {
      const notice = path.join(destination, name);
      if (!fs.lstatSync(notice).isFile() || !fs.readFileSync(notice).equals(fs.readFileSync(path.join(source, name)))) {
        throw Error('Changed Windows installer notice: ' + name);
      }
    }
  }
}

module.exports = { stagePackageNotices, verifyPackageNotices };
