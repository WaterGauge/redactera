const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
try {
  const root = path.resolve(__dirname, '..');
  const packages = path.join(root, '.project-state/e2e/packages');
  const candidates = fs.readdirSync(packages).filter(name => name.endsWith(`-${process.platform}-${process.arch}`));
  if (candidates.length !== 1) throw Error('Build one native E2E package with npm run package -- --test-inspect first.');
  const evidence = JSON.parse(fs.readFileSync(path.join(packages, candidates[0], 'build-evidence.json'), 'utf8'));
  if (!path.isAbsolute(evidence.binary) || !evidence.binary.startsWith(packages + path.sep)) throw Error('Invalid E2E package identity.');
  const result = cp.spawnSync(process.execPath, [path.join(root, 'scripts/run-e2e.cjs'), '--packaged', evidence.binary, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || Error('Packaged E2E failed');
} catch (error) { console.error(error.message); process.exitCode = 1; }
