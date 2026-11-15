const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { createZstdDecompress } = require('node:zlib');
const extractZip = require('extract-zip');
const tar = require('tar');

const state = path.resolve(__dirname, '../.project-state/windows-ocr');
const lock = fs.readFileSync(path.join(__dirname, 'windows-ocr-lock.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = file => hash(fs.readFileSync(file));
const pinned = JSON.parse(lock);
const destination = path.join(state, hash(lock));
const expected = pinned.packages.flatMap(pkg => pkg.files).map(file => path.posix.basename(file.member)).sort();

function verifyPrepared(directory) {
  assert(fs.lstatSync(directory).isDirectory(), 'Expected a prepared OCR directory');
  assert.deepEqual(fs.readdirSync(directory).sort(), expected, 'Prepared OCR file list differs from the lock');
  for (const pkg of pinned.packages) {
    for (const file of pkg.files) {
      const prepared = path.join(directory, path.posix.basename(file.member));
      assert(fs.lstatSync(prepared).isFile() && sha(prepared) === file.sha256, 'Prepared OCR file hash differs from the lock');
    }
  }
}

async function stagePackage(pkg, work, assembled) {
  assert(/^[\w.-]+\.conda$/.test(pkg.archive));
  assert.match(pkg.sha256, /^[0-9a-f]{64}$/);
  for (const file of pkg.files) {
    assert.match(file.member, /^Library\/bin\/[\w.-]+\.(?:dll|exe)$/i);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
  const cached = path.join(state, 'packages', pkg.archive);
  let archive = cached;
  if (!fs.existsSync(cached)) {
    const response = await fetch('https://conda.anaconda.org/conda-forge/win-64/' + pkg.archive,
      { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error('Could not download ' + pkg.archive + ' (' + response.status + ')');
    archive = path.join(work, pkg.archive);
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
  }
  assert(fs.lstatSync(archive).isFile() && sha(archive) === pkg.sha256, 'OCR archive hash mismatch: ' + pkg.archive);
  const zip = fs.mkdtempSync(path.join(work, 'zip-'));
  await extractZip(archive, { dir: zip });
  const payloads = fs.readdirSync(zip).filter(name => /^pkg-[\w.-]+\.tar\.zst$/.test(name));
  assert.equal(payloads.length, 1, 'Expected one Conda payload');
  const entries = new Set(pkg.files.map(file => file.member));
  await pipeline(fs.createReadStream(path.join(zip, payloads[0])), createZstdDecompress(),
    tar.x({ cwd: zip, strict: true, filter: (member, entry) => entries.has(member) && entry.type === 'File' }));
  for (const file of pkg.files) {
    const binary = path.join(zip, ...file.member.split('/'));
    assert(fs.lstatSync(binary).isFile() && sha(binary) === file.sha256, 'OCR file hash mismatch: ' + file.member);
    fs.copyFileSync(binary, path.join(assembled, path.posix.basename(file.member)), fs.constants.COPYFILE_EXCL);
  }
}

async function main() {
  assert(expected.includes('tesseract.exe'));
  assert.equal(new Set(expected.map(name => name.toLowerCase())).size, expected.length);
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(state, { recursive: true });
    const work = fs.mkdtempSync(path.join(state, 'prepare-'));
    try {
      const assembled = path.join(work, 'runtime');
      fs.mkdirSync(assembled);
      for (const pkg of pinned.packages) await stagePackage(pkg, work, assembled);
      verifyPrepared(assembled);
      try { fs.renameSync(assembled, destination); }
      catch (error) { if (!fs.existsSync(destination)) throw error; }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  verifyPrepared(destination);
  console.log(path.join(destination, 'tesseract.exe'));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
