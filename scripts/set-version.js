const fs = require('node:fs');
const path = require('node:path');
const { assertReleaseVersion, readVersionFiles } = require('./release-version.cjs');

function setVersion(root, version) {
  const state = path.join(root, '.project-state');
  fs.mkdirSync(state, { recursive: true });
  const writer = path.join(state, 'set-version.lock');
  const descriptor = fs.openSync(writer, 'wx', 0o600);
  let staging;
  let keepBackup = false;
  try {
    const { packagePath, lockPath, pkg, lock, lockBytes } = readVersionFiles(root);
    if (pkg.version === version && lock.version === version && lock.packages[''].version === version) return;

    pkg.version = version;
    lock.version = version;
    lock.packages[''].version = version;
    staging = fs.mkdtempSync(path.join(state, 'set-version-'));
    const nextPackage = path.join(staging, 'package.json');
    const nextLock = path.join(staging, 'package-lock.json');
    const previousLock = path.join(staging, 'previous-package-lock.json');
    const packageMode = fs.statSync(packagePath).mode & 0o777;
    const lockMode = fs.statSync(lockPath).mode & 0o777;
    fs.writeFileSync(nextPackage, JSON.stringify(pkg, null, 2) + '\n', { flag: 'wx', mode: packageMode });
    fs.writeFileSync(nextLock, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx', mode: lockMode });
    fs.writeFileSync(previousLock, lockBytes, { flag: 'wx', mode: lockMode });

    fs.renameSync(nextLock, lockPath);
    try {
      fs.renameSync(nextPackage, packagePath);
    } catch (error) {
      try {
        fs.renameSync(previousLock, lockPath);
      } catch {
        keepBackup = true;
        throw Error('Version update failed and the previous lock file is saved in ' + staging, { cause: error });
      }
      throw error;
    }
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(writer);
    if (staging && !keepBackup) fs.rmSync(staging, { recursive: true });
  }
}

try {
  if (process.argv.length !== 3) throw Error('Usage: npm run set-version -- X.Y.Z');
  const version = assertReleaseVersion(process.argv[2]);
  setVersion(path.resolve(__dirname, '..'), version);
  console.log('Version set to ' + version);
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Another version update owns the version lock.' : error.message);
  process.exitCode = 1;
}
