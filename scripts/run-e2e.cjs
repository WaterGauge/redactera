const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const build = require('../e2e/support/build.cjs');
const { sourceSnapshot, directorySnapshot } = require('../e2e/support/evidence.cjs');

const root = path.resolve(__dirname, '..');
const base = path.join(root, '.project-state', 'e2e', 'runs');
fs.mkdirSync(base, { recursive: true });
// Native test dialogs cannot grant access to macOS protected folders. Keep
// synthetic runtime files in the OS temp area, then archive bounded evidence.
const run = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-pdf-e2e-')));
const artifacts = path.join(base, path.basename(run));
fs.mkdirSync(artifacts);
const runId = crypto.randomUUID();
const args = process.argv.slice(2);
let negativeControl = '', appBinary = '', suite = 'workflow';
while (args.length) {
  const option = args.shift(), value = args.shift();
  if (option === '--negative-control' && ['unredacted-result', 'ocr-overlay'].includes(value) && !negativeControl) negativeControl = value;
  else if (option === '--packaged' && value && path.isAbsolute(value) && !appBinary) appBinary = value;
  else if (option === '--suite' && ['readiness', 'native-dialogs'].includes(value) && suite === 'workflow') suite = value;
  else throw Error('Supported options: --suite readiness|native-dialogs; --negative-control unredacted-result|ocr-overlay; --packaged ABSOLUTE_E2E_BINARY');
}
if (suite !== 'workflow' && negativeControl) throw Error('Negative controls require the workflow suite');
if (suite === 'native-dialogs' && (process.platform !== 'darwin' || !appBinary)) throw Error('Native dialog acceptance requires an isolated packaged E2E app on an interactive Mac');
const expectedTests = suite === 'workflow' ? 17 : 3;
fs.writeFileSync(path.join(base, 'latest.json'), JSON.stringify({ run: artifacts, executionRun: run, runId }, null, 2));
fs.writeFileSync(path.join(run, 'execution-directory.json'), JSON.stringify({ runId, executionRun: run, artifacts }, null, 2));
console.log(`E2E artifacts: ${artifacts}`);

function execute(command, args, options = {}) {
  const result = cp.spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120000, ...options });
  if (result.error || result.status !== 0) throw result.error || Error(`Command failed (${result.status}): ${path.basename(command)}`);
  return result.stdout;
}

(async () => {
  const before = sourceSnapshot(root);
  fs.writeFileSync(path.join(run, 'source-before.json'), JSON.stringify(before, null, 2));
  const configured = process.env.PDF_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const python = execute(configured, ['-c', 'import sys,pymupdf,PIL; print(sys.executable)']).trim();
  if (!path.isAbsolute(python)) throw Error('Python executable is not absolute');
  let overlayHelperSha256 = '';
  if (negativeControl === 'ocr-overlay') {
    const helper = path.join(root, 'e2e/support/unsafe-overlay.py');
    const staged = path.join(run, 'unsafe-overlay.py');
    fs.copyFileSync(helper, staged);
    overlayHelperSha256 = crypto.createHash('sha256').update(fs.readFileSync(staged)).digest('hex');
    if (overlayHelperSha256 !== before.files['e2e/support/unsafe-overlay.py']) throw Error('Overlay helper changed while staging');
    fs.writeFileSync(path.join(run, 'overlay-helper.json'), JSON.stringify({ sha256: overlayHelperSha256 }, null, 2));
  }
  fs.mkdirSync(path.join(run, 'exports'));
  const suppliedFixtures = process.env.PDF_TEST_FIXTURE_DIR;
  if (suppliedFixtures) {
    const sourceDirectory = path.resolve(suppliedFixtures);
    execute(python, ['e2e/fixtures/generate-fixtures.py', '--output-directory', sourceDirectory, '--verify-only']);
    fs.mkdirSync(path.join(run, 'fixtures'));
    for (const name of ['manifest.json', 'sample.pdf', 'crossline-sample.pdf', 'scanned.pdf', 'mixed.pdf']) fs.copyFileSync(path.join(sourceDirectory, name), path.join(run, 'fixtures', name));
  } else {
    execute(python, ['e2e/fixtures/generate-fixtures.py', '--output-directory', path.join(run, 'fixtures')]);
  }
  execute(python, ['e2e/fixtures/generate-fixtures.py', '--output-directory', path.join(run, 'fixtures'), '--verify-only']);
  if (suite === 'readiness') execute(python, ['e2e/fixtures/preview-fixture.py', '--directory', path.join(run, 'fixtures')]);
  const ocr = JSON.parse(execute(python, ['e2e/support/ocr-source-check.py', '--fixtures', path.join(run, 'fixtures')]));
  fs.writeFileSync(path.join(run, 'ocr-source-controls.json'), JSON.stringify(ocr, null, 2));
  const manifest = JSON.parse(fs.readFileSync(path.join(run, 'fixtures', 'manifest.json'), 'utf8'));
  const pkg = require('../package.json');
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ runId, mode: appBinary ? 'packaged-e2e-main' : 'source-production-main', platform: process.platform,
    arch: process.arch, version: pkg.version, node: process.version, fixtureManifest: manifest, suppliedFixtures: Boolean(suppliedFixtures), negativeControl, suite }, null, 2));
  if (appBinary) {
    const output = process.platform === 'darwin' ? path.resolve(path.dirname(appBinary), '../../..') : path.dirname(appBinary);
    const evidence = await require('./backend-contract.cjs').verifyPackage(root, output, process.platform, process.arch, 'e2e', false);
    if (evidence.binary !== appBinary) throw Error('The supplied executable is not the declared E2E package');
    fs.writeFileSync(path.join(run, 'package-evidence.json'), JSON.stringify(evidence, null, 2));
  } else {
    await build(root, path.join(run, 'build'));
    fs.writeFileSync(path.join(run, 'build-hashes.json'), JSON.stringify(directorySnapshot(path.join(run, 'build')), null, 2));
  }
  const appDirectory = path.join(run, 'app'); fs.mkdirSync(appDirectory);
  fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({ name: pkg.name + '-e2e', version: pkg.version, main: 'main.cjs' }));
  fs.writeFileSync(path.join(appDirectory, 'main.cjs'), `require(${JSON.stringify(path.join(root, 'e2e/support/bootstrap.cjs'))});\n`);
  const cli = path.join(root, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');
  const env = { ...process.env, PDF_E2E_ROOT: root, PDF_E2E_RUN: run, PDF_E2E_RUN_ID: runId, PDF_TEST_PYTHON: python,
    CHROME_LOG_FILE: path.join(run, 'chromium-startup.log'),
    PDF_DESENSITIZATION_PYTHON: python,
    PDF_E2E_APP_BINARY: appBinary,
    PDF_E2E_SUITE: suite,
    PDF_E2E_NATIVE_DIALOGS: suite === 'native-dialogs' ? 'true' : 'false',
    PDF_E2E_NEGATIVE_CONTROL: negativeControl, PDF_E2E_OVERLAY_HELPER_SHA256: overlayHelperSha256 };
  if (!appBinary) {
    env.PATH = path.dirname(ocr.executable) + path.delimiter + (process.env.PATH || '');
    env.TESSDATA_PREFIX = ocr.tessdataDirectory;
  }
  let overlayRequestHandled = false;
  const overlayWorker = negativeControl === 'ocr-overlay' ? setInterval(() => {
    const requestFile = path.join(run, 'overlay-request.json');
    if (overlayRequestHandled || !fs.existsSync(requestFile)) return;
    overlayRequestHandled = true;
    const response = { runId, created: false, executedBy: 'external-test-runner' };
    try {
      const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
      const sessionRoot = fs.realpathSync(path.join(run, 'profile/file-sessions')) + path.sep;
      if (request.runId !== runId || request.inputPath !== path.join(run, 'fixtures/scanned.pdf') ||
          !fs.lstatSync(request.outputPath).isFile() || !fs.realpathSync(request.outputPath).startsWith(sessionRoot)) {
        throw Error('Unsafe overlay mutation request');
      }
      const helper = path.join(run, 'unsafe-overlay.py');
      if (crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex') !== overlayHelperSha256) {
        throw Error('Overlay helper identity mismatch');
      }
      const mutation = cp.spawnSync(python, [helper, request.inputPath, request.outputPath],
        { cwd: run, input: JSON.stringify(request.review), encoding: 'utf8', timeout: 10000 });
      Object.assign(response, { status: mutation.status, signal: mutation.signal, spawnErrorCode: mutation.error?.code,
        created: !mutation.error && mutation.status === 0 });
    } catch { response.validationFailed = true; }
    const output = path.join(run, 'overlay-response.json');
    fs.writeFileSync(output + '.tmp', JSON.stringify(response));
    fs.renameSync(output + '.tmp', output);
  }, 50) : undefined;
  // Native Node inspector initialization resolves cwd before the JS test host
  // can run. A packaged Mac process can stall on a protected Desktop cwd.
  // Keep test launch IO in the same owned OS-temp namespace as its profile.
  const child = cp.spawn(process.execPath, [cli, 'run', path.join(root, 'wdio.conf.ts')], {
    cwd: process.platform === 'darwin' ? run : root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const tree = process.platform === 'win32' ? undefined : require('../e2e/support/process-tree.cjs').track(child.pid);
  fs.writeFileSync(path.join(run, 'runner-process.json'), JSON.stringify({ pid: child.pid, parentPid: process.pid, command: process.execPath, cli }));
  const log = fs.createWriteStream(path.join(run, 'wdio.log'));
  child.stdout.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { log.write(chunk); process.stderr.write(chunk); });
  const stopOwnedTree = (signal = 'SIGTERM') => {
    if (process.platform === 'win32') {
      // Only an active launcher PID may be passed to taskkill. A completed
      // launch is left to WDIO cleanup; Windows orphan handling needs native validation.
      if (child.exitCode === null) cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } else {
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  let timedOut = false;
  let forcedStop;
  const watchdog = setTimeout(() => {
    timedOut = true;
    fs.writeFileSync(path.join(run, 'request-quit'), runId);
    forcedStop = setTimeout(() => stopOwnedTree('SIGKILL'), 15000);
  }, 360000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }).finally(() => {
    clearTimeout(watchdog); clearTimeout(forcedStop); clearInterval(overlayWorker);
  });
  await new Promise(resolve => log.end(resolve));
  fs.writeFileSync(path.join(run, 'request-quit'), runId);
  if (fs.existsSync(path.join(run, 'host-observations.json'))) {
    for (let attempt = 0; attempt < 150 && !fs.existsSync(path.join(run, 'shutdown.json')); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  // macOS can put Electron in its own process group. Track actual descendants
  // by PID and birth identity, including those later reparented after a crash.
  if (tree) {
    const stopped = await tree.stop();
    fs.writeFileSync(path.join(run, 'runner-tree-shutdown.json'), JSON.stringify(stopped, null, 2));
    if (!stopped.confirmed) throw Error('Owned test process descendants have not confirmed exit');
  } else stopOwnedTree();
  execute(python, ['e2e/fixtures/generate-fixtures.py', '--output-directory', path.join(run, 'fixtures'), '--verify-only']);
  if (suite === 'readiness') execute(python, ['e2e/fixtures/preview-fixture.py', '--directory', path.join(run, 'fixtures'), '--verify-only']);
  const after = sourceSnapshot(root);
  fs.writeFileSync(path.join(run, 'source-after.json'), JSON.stringify(after, null, 2));
  if (before.sha256 !== after.sha256) throw Error('Source changed during the E2E run; rerun against a stable snapshot');
  const report = JSON.parse(fs.readFileSync(path.join(run, 'test-results.json'), 'utf8'));
  if (negativeControl === 'ocr-overlay') {
    const shutdown = JSON.parse(fs.readFileSync(path.join(run, 'shutdown.json'), 'utf8'));
    const observations = JSON.parse(fs.readFileSync(path.join(run, 'host-observations.json'), 'utf8'));
    const mutations = observations.requests.filter(request => request.negativeControl?.created);
    if (timedOut || code === 0 || report.runId !== runId || report.passed !== 8 || report.failed !== 1 || report.skipped ||
        report.tests.length !== 9 || report.tests.slice(0, 8).some(test => !test.passed) || report.tests[8].passed ||
        !report.tests[8].error?.includes('Sensitive pixels remain in a stored PDF image') || mutations.length !== 1 ||
        mutations[0].negativeControl.helperSha256 !== overlayHelperSha256 ||
        shutdown.liveOwnedBackendPids.length || shutdown.remainingSessions.length) throw Error('Overlay negative control failed for an unexpected reason');
    const content = JSON.parse(execute(python, ['e2e/support/verify-ocr-negative.py', '--fixtures', path.join(run, 'fixtures'),
      '--unsafe-result', path.join(run, 'exports/scanned.pdf')]));
    fs.writeFileSync(path.join(run, 'negative-control.json'), JSON.stringify({ runId, verified: true,
      expectedFailure: 'Sensitive pixels remain in a stored PDF image', sourceSha256: before.sha256, content, shutdown }, null, 2));
    console.log('Overlay negative control verified: saved black overlay rejected for retained sensitive pixels');
    process.exitCode = 1; // A deliberate unsafe export must never produce a successful E2E exit.
    return;
  }
  if (timedOut || code !== 0 || report.runId !== runId || report.passed !== expectedTests || report.failed || report.skipped ||
      report.tests.length !== expectedTests || report.tests.some(test => !test.passed) || new Set(report.tests.map(test => test.title)).size !== expectedTests) throw Error('E2E did not complete all required assertions');
  const shutdown = JSON.parse(fs.readFileSync(path.join(run, 'shutdown.json'), 'utf8'));
  if (shutdown.liveOwnedBackendPids.length || shutdown.remainingSessions.length) throw Error('E2E shutdown did not complete');
  fs.writeFileSync(path.join(run, 'runner-success.json'), JSON.stringify({ runId, passed: report.passed, sourceSha256: before.sha256, shutdown }, null, 2));
  console.log(`E2E passed: ${report.passed} tests`);
})().catch(error => {
  fs.writeFileSync(path.join(run, 'runner-failure.json'), JSON.stringify({ runId, error: String(error.message) }));
  console.error(error); process.exitCode = 1;
}).finally(() => {
  for (const name of fs.readdirSync(run)) {
    if (!['profile', 'build', 'app'].includes(name)) fs.cpSync(path.join(run, name), path.join(artifacts, name), { recursive: true });
  }
  const shutdownFile = path.join(run, 'shutdown.json');
  const shutdown = fs.existsSync(shutdownFile) ? JSON.parse(fs.readFileSync(shutdownFile, 'utf8')) : null;
  const owner = JSON.parse(fs.readFileSync(path.join(run, 'execution-directory.json'), 'utf8'));
  const treeFile = path.join(run, 'runner-tree-shutdown.json');
  const treeStopped = process.platform === 'win32' || fs.existsSync(treeFile) && JSON.parse(fs.readFileSync(treeFile, 'utf8')).confirmed;
  if (owner.runId === runId && treeStopped && shutdown && !shutdown.liveOwnedBackendPids.length &&
      !shutdown.remainingSessions.length) fs.rmSync(run, { recursive: true, force: true });
});
