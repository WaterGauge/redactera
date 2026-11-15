const fs = require('node:fs');
const path = require('node:path');

function assertReleaseVersion(version) {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$/;
  if (typeof version !== 'string' || version !== version.trim() || !pattern.test(version)) {
    throw Error('Use X.Y.Z or X.Y.Z-{alpha,beta,rc}.N, with a positive prerelease number.');
  }
  return version;
}

function readVersionFiles(root) {
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const lockBytes = fs.readFileSync(lockPath);
  const lock = JSON.parse(lockBytes.toString('utf8'));
  if (!pkg.name || lock.name !== pkg.name || lock.packages?.['']?.name !== pkg.name) {
    throw Error('package-lock.json does not identify the root package.');
  }
  return { packagePath, lockPath, pkg, lock, lockBytes };
}

function verifyReleaseVersion(root, ref) {
  const prefix = 'refs/tags/v';
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) throw Error('A release tag ref is required.');
  const version = assertReleaseVersion(ref.slice(prefix.length));
  const { pkg, lock } = readVersionFiles(root);
  if (pkg.version !== version || lock.version !== version || lock.packages[''].version !== version) {
    throw Error('The release tag, package.json and package-lock.json must have the same version.');
  }
  return { version, prerelease: version.includes('-') };
}

module.exports = { assertReleaseVersion, readVersionFiles, verifyReleaseVersion };

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    console.log(JSON.stringify(verifyReleaseVersion(root, process.argv[2] ?? process.env.GITHUB_REF)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
