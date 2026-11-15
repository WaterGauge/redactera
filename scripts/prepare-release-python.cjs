// Install the verified native Python runtime into an isolated project directory.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pythonRuntime } = require('./release-upstream.json');

function prepare(archiveOverride) {
  const target = process.platform + '-' + process.arch;
  const input = pythonRuntime.distributions[target];
  assert(input, 'No release Python distribution for ' + target);
  const state = process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, 'redactera-release-python')
    : path.resolve(__dirname, '../.project-state/release-python');
  fs.mkdirSync(state, { recursive: true });
  const work = fs.mkdtempSync(path.join(state, 'runtime-'));
  try {
    const archive = path.join(work, 'python.tar.gz');
    if (archiveOverride) {
      fs.copyFileSync(archiveOverride, archive, fs.constants.COPYFILE_EXCL);
    } else {
      execFileSync('curl', ['--fail', '--location', '--silent', '--show-error',
        '--proto', '=https', '--proto-redir', '=https', '--retry', '3',
        '--connect-timeout', '15', '--max-time', '120', '--output', archive, input.url],
      { stdio: ['ignore', 'ignore', 'inherit'], timeout: 540_000 });
    }
    const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    assert.equal(digest, input.sha256, 'Release Python archive checksum mismatch');
    // Git Bash's GNU tar interprets a drive letter in the archive argument as a remote host.
    execFileSync('tar', ['-xzf', path.basename(archive)], { cwd: work, stdio: 'inherit', timeout: 90_000 });
    const bin = path.join(work, process.platform === 'win32' ? 'python' : 'python/bin');
    const executable = path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python');
    const output = execFileSync(executable, ['-I', '-c',
      'import json, platform, ssl, sys\n' +
      'print(json.dumps([sys.platform, platform.machine().lower(), platform.python_version(), ssl.OPENSSL_VERSION]))'],
    { encoding: 'utf8', timeout: 30_000 });
    const [system, machine, python, tls] = JSON.parse(output);
    const arch = { arm64: 'arm64', aarch64: 'arm64', amd64: 'x64', x86_64: 'x64' }[machine];
    assert.equal(system + '-' + arch, target, 'Release Python architecture mismatch');
    assert.equal(python, pythonRuntime.python, 'Release Python version mismatch');
    const [, provider, openssl] = /^(\S+)\s+(\S+)/.exec(tls) ?? [];
    assert.equal(provider, 'OpenSSL', 'Release TLS provider mismatch');
    assert.equal(openssl, pythonRuntime.openssl, 'Release OpenSSL version mismatch');
    fs.unlinkSync(archive);
    return { bin, executable, python, openssl, archiveSha256: digest };
  } catch (error) {
    fs.rmSync(work, { recursive: true, force: true });
    throw error;
  }
}

try {
  assert(process.argv.length <= 3, 'Use prepare-release-python.cjs [PATH_TO_PINNED_ARCHIVE]');
  const result = prepare(process.argv[2]);
  if (process.env.GITHUB_PATH) fs.appendFileSync(process.env.GITHUB_PATH, result.bin + '\n');
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV,
      `PDF_BUILD_PYTHON=${result.executable}\nPDF_TEST_PYTHON=${result.executable}\n`);
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
