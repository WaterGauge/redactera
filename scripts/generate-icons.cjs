const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) throw Error('Use npm run icons:generate [-- --check]');
const root = path.resolve(__dirname, '..');
const python = process.env.PDF_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, [path.join(__dirname, 'generate-icons.py'), ...args],
  { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) console.error('Unable to run the pinned Python icon generator:', result.error.code);
process.exitCode = result.error ? 1 : result.status ?? 1;
