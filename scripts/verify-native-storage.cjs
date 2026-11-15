const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const webpack = require('webpack');
const root = path.resolve(__dirname, '..');
const run = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-native-storage-')));
fs.writeFileSync(path.join(run, 'owner.json'), JSON.stringify({ run, runId: crypto.randomUUID() }));
console.log('Isolated native storage run: ' + run);

(async () => {
  const compiler = webpack({ mode: 'production', target: 'electron-main', entry: path.join(root, 'e2e/support/native-storage.ts'),
    output: { path: path.join(run, 'app'), filename: 'main.cjs' }, devtool: false,
    resolve: { extensions: ['.ts', '.js'] },
    module: { rules: [{ test: /\.ts$/, loader: require.resolve('ts-loader'), options: { transpileOnly: true, configFile: path.join(root, 'tsconfig.e2e.json') } }] },
  });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(closeError =>
    error || closeError || !stats || stats.hasErrors() ? reject(error || closeError || Error(stats.toString({ all: false, errors: true }))) : resolve())));
  fs.writeFileSync(path.join(run, 'app/package.json'), JSON.stringify({ name: 'pdf-native-storage-check', version: '1.0.0', main: 'main.cjs' }));
  const pids = [];
  for (const phase of ['save', 'restart']) {
    const child = cp.spawnSync(require('electron'), [path.join(run, 'app')], { cwd: root,
      env: { ...process.env, PDF_STORAGE_RUN: run, PDF_STORAGE_PHASE: phase }, encoding: 'utf8', timeout: 60000 });
    pids.push(child.pid);
    // Native framework stderr may contain paths. Keep it in local evidence only.
    fs.writeFileSync(path.join(run, phase + '.stderr.log'), child.stderr || '');
    if (child.error || child.status !== 0) throw Error('Native storage phase did not pass: ' + phase);
    const report = JSON.parse(fs.readFileSync(path.join(run, phase + '.json'), 'utf8'));
    if (!report.verified) throw Error('Native storage assertions failed: ' + phase);
  }
  const artifacts = path.join(root, '.project-state/native-storage', path.basename(run));
  fs.mkdirSync(artifacts, { recursive: true });
  for (const name of ['owner.json', 'save.json', 'restart.json', 'save.stderr.log', 'restart.stderr.log']) fs.copyFileSync(path.join(run, name), path.join(artifacts, name));
  fs.writeFileSync(path.join(artifacts, 'processes.json'), JSON.stringify({ pids, exited: true }));
  fs.rmSync(run, { recursive: true });
  console.log(JSON.stringify({ verified: true, artifacts, pids }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
