// The local receipt binds the common app directory, not installer-only files.
const cp = require('node:child_process');
const path = require('node:path');

function run(mode, root, output, evidence) {
  const python = process.env.PDF_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const sourceCommit = process.env.PDF_REQUIRE_RELEASE_RUNTIME === '1'
    ? cp.execFileSync('git', ['rev-parse', '--verify', (process.env.PDF_RELEASE_SOURCE_COMMIT || 'HEAD') + '^{commit}'],
      { cwd: root, encoding: 'utf8', timeout: 10000 }).trim() : null;
  const proof = { appBuild: evidence.appBuild, asarSha256: evidence.asarSha256,
    backendSha256: evidence.backendSha256, pythonLicensesSha256: evidence.pythonLicensesSha256, sourceCommit };
  const result = cp.execFileSync(python, [path.join(__dirname, 'application-payload.py'), mode, path.resolve(root), path.resolve(output)],
    { cwd: root, input: JSON.stringify(proof), encoding: 'utf8', timeout: 180000 });
  return JSON.parse(result);
}

module.exports = {
  sealWindowsPayload: (root, output, evidence) => run('seal', root, output, evidence),
  verifyWindowsPayload: (root, output, evidence) => run('verify', root, output, evidence),
};
