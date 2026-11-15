const cp = require('node:child_process');
const path = require('node:path');
const { verify } = require('./backend-contract.cjs');
const root = path.resolve(__dirname, '..');

function buildBackend() {
  if (!['darwin', 'win32'].includes(process.platform)) throw Error('Use native Windows Node/Python for Windows builds, or native macOS tools for macOS builds.');
  const python = process.env.PDF_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const identity = cp.spawnSync(python, ['-c', 'import sys,platform,json; print(json.dumps([sys.platform, platform.machine().lower()]))'], { encoding: 'utf8', timeout: 10000 });
  if (identity.error || identity.status !== 0) throw identity.error || Error('Python is unavailable');
  const [platform, machine] = JSON.parse(identity.stdout);
  const arch = { arm64: 'arm64', aarch64: 'arm64', x86_64: 'x64', amd64: 'x64' }[machine];
  if (platform !== process.platform || arch !== process.arch) throw Error('Node and Python must target the same native OS and architecture.');
  const result = cp.spawnSync(python, [path.join(root, 'python-backend/build_backend.py')], { cwd: root, stdio: 'inherit', timeout: 600000 });
  if (result.error || result.status !== 0) throw result.error || Error(`Backend build failed (${result.status})`);
  return verify(root);
}
module.exports = buildBackend;
if (require.main === module) {
  try { buildBackend(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
