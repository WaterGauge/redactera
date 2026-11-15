// Explicit CI resource preparation; the backend builder never downloads or installs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const revision = '87416418657359cb625c412a48b6e1d6d41c29bd';
const hashes = {
  eng: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
  chi_sim: 'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730',
  chi_tra: '529c5b5797d64b126065cd55f2bb4c7fd7b15790798091b1ff259941a829330b',
};
const directory = path.resolve(__dirname, '..', '.project-state', 'ocr-data');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
(async () => {
  fs.mkdirSync(directory, { recursive: true });
  await Promise.all(Object.entries(hashes).map(async ([language, expected]) => {
    const file = path.join(directory, `${language}.traineddata`);
    if (fs.existsSync(file) && digest(fs.readFileSync(file)) === expected) return;
    const response = await fetch(`https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${revision}/${language}.traineddata`,
      { redirect: 'error', signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw Error(`OCR language download failed: ${language}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 10000000 || digest(bytes) !== expected) throw Error(`OCR language checksum mismatch: ${language}`);
    fs.writeFileSync(file + '.tmp', bytes); fs.renameSync(file + '.tmp', file);
  }));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ revision, hashes }, null, 2));
  console.log(`Verified three pinned OCR languages: ${directory}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
