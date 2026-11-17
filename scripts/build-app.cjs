const cp = require('node:child_process');
const path = require('node:path');
const buildBackend = require('./build-backend.cjs');
const { applicationSource } = require('./backend-contract.cjs');
const [command, ...args] = process.argv.slice(2);
const inspect = args.length === 1 && args[0] === '--test-inspect';
const fromPackage = args.length === 1 && args[0] === '--from-package';
if (!['package', 'make'].includes(command) || (args.length && !inspect && !fromPackage)) throw Error('Use package [--test-inspect] or make [--from-package]; cross-platform/architecture builds require native tools.');
if (inspect && command !== 'package') throw Error('The E2E flavor is only a test package; it cannot produce installers.');
if (fromPackage && (command !== 'make' || process.platform !== 'win32' || process.arch !== 'x64')) {
  throw Error('Reusing a sealed application payload requires native Windows x64 make.');
}
try {
  const root = path.resolve(__dirname, '..');
  if (process.env.PDF_REQUIRE_RELEASE_RUNTIME === '1') {
    process.env.PDF_RELEASE_SOURCE_COMMIT = cp.execFileSync('git', ['rev-parse', '--verify',
      (process.env.PDF_RELEASE_SOURCE_COMMIT || 'HEAD') + '^{commit}'], { cwd: root, encoding: 'utf8' }).trim();
    applicationSource(root);
  }
  if (!fromPackage) buildBackend();
  const cli = path.join(root, 'node_modules/@electron-forge/cli/dist/electron-forge.js');
  const result = cp.spawnSync(process.execPath, [cli, command, ...(fromPackage ? ['--from-package'] : [])], { cwd: root, stdio: 'inherit',
    env: { ...process.env, PDF_E2E_BUILD: inspect ? 'true' : 'false', ELECTRON_ENABLE_NODE_CLI_INSPECT_ARGUMENTS: inspect ? 'true' : 'false' } });
  if (result.error || result.status !== 0) throw result.error || Error(`Forge ${command} failed (${result.status})`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
