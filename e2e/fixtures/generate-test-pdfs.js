const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const python = process.env.PDF_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const output = path.resolve(root, process.env.PDF_TEST_FIXTURE_DIR || '.project-state/e2e-fixtures');
const result = spawnSync(python, [path.join(__dirname, 'generate-fixtures.py'), '--output-directory', output, ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', shell: false,
});
if (result.error) console.error('Unable to run fixture generator. Set PDF_TEST_PYTHON to a Python environment with PyMuPDF.');
process.exitCode = result.error ? 1 : result.status ?? 1;
