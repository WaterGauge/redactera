const cp = require('node:child_process');
const path = require('node:path');
const buildBackend = require('./build-backend.cjs');
const [command, ...args] = process.argv.slice(2);
const inspect = args.length === 1 && args[0] === '--test-inspect';
if (!['package', 'make'].includes(command) || (args.length && !inspect)) throw Error('Use package|make [--test-inspect]; cross-platform/architecture builds require native tools.');
if (inspect && command !== 'package') throw Error('The E2E flavor is only a test package; it cannot produce installers.');
try {
  buildBackend();
  const root = path.resolve(__dirname, '..');
  const cli = path.join(root, 'node_modules/@electron-forge/cli/dist/electron-forge.js');
  const result = cp.spawnSync(process.execPath, [cli, command], { cwd: root, stdio: 'inherit',
    env: { ...process.env, PDF_E2E_BUILD: inspect ? 'true' : 'false', ELECTRON_ENABLE_NODE_CLI_INSPECT_ARGUMENTS: inspect ? 'true' : 'false' } });
  if (result.error || result.status !== 0) throw result.error || Error(`Forge ${command} failed (${result.status})`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
