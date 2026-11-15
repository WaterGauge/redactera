// Validate committed icon outputs without a Python dependency at package time.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const ICNS_SIZES = { icp4: 16, ic11: 32, icp5: 32, ic12: 64, ic07: 128,
  ic13: 256, ic08: 256, ic14: 512, ic09: 512, ic10: 1024 };
const INPUTS = ['redactera-icon-sources/redactera-macos-source.png',
  'redactera-icon-sources/redactera-windows-source.png',
  'redactera-icon-sources/redactera-macos-cutout.png',
  'redactera-icon-sources/redactera-windows-cutout.png', 'scripts/generate-icons.py'];
const OUTPUTS = ['assets/redactera-macos.png', 'assets/redactera-windows.png',
  'assets/icon.ico', 'assets/icon.icns', 'assets/installer.gif'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Error('Icon resources: ' + message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? (0xedb88320 ^ (n >>> 1)) : (n >>> 1);
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function png(bytes, expectedSize) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('invalid PNG');
  let offset = 8, header, ended = false;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) fail('truncated PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail('PNG checksum mismatch');
    if (offset === 8 && type !== 'IHDR') fail('PNG header missing');
    if (type === 'IHDR') {
      if (header || length !== 13) fail('invalid PNG header');
      header = data;
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') { ended = length === 0 && end === bytes.length; offset = end; break; }
    offset = end;
  }
  if (!ended || !header || !compressed.length || offset !== bytes.length) fail('incomplete PNG');
  if (header.readUInt32BE(0) !== expectedSize || header.readUInt32BE(4) !== expectedSize ||
      header[8] !== 8 || header[9] !== 6 || header[10] || header[11] || header[12]) fail('wrong PNG size or RGBA format');
  const expectedBytes = expectedSize * (expectedSize * 4 + 1);
  const decoded = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes });
  if (decoded.length !== expectedBytes) fail('wrong PNG pixel length');
  for (let y = 0; y < expectedSize; y++) if (decoded[y * (expectedSize * 4 + 1)] > 4) fail('invalid PNG filter');
}
function alpha(info) {
  if (!info || info.alphaMin !== 0 || info.alphaMax < 240 || info.alphaMax > 255 ||
      !info.transparentPixels || !Array.isArray(info.alphaBounds) || info.alphaBounds.length !== 4) fail('missing transparent foreground proof');
}
function verifyIcons(root = path.resolve(__dirname, '..')) {
  const file = path.join(root, 'assets/icon-manifest.json');
  const manifestBytes = fs.readFileSync(file), m = JSON.parse(manifestBytes);
  if (m.schema !== 1 || m.generator !== 'scripts/generate-icons.py' || m.pillowVersion !== '11.1.0' ||
      !equal(m.alphaPolicy, { transparentAtMost: 1, opaqueAtLeast: 250 }) ||
      !equal(m.coverage, { macos: 0.82, windows: 0.90 })) fail('unknown generation plan');
  for (const [names, entries] of [[INPUTS, m.inputs], [OUTPUTS, m.outputs]]) {
    if (!entries || !equal(Object.keys(entries).sort(), [...names].sort())) fail('missing or unexpected icon files');
    for (const name of names) {
      const bytes = fs.readFileSync(path.join(root, name));
      if (!/^[a-f0-9]{64}$/.test(entries[name]) || hash(bytes) !== entries[name]) {
        fail(name + ' changed; run npm run icons:generate');
      }
    }
  }
  for (const name of OUTPUTS.filter(name => name.endsWith('.png'))) {
    png(fs.readFileSync(path.join(root, name)), 1024); alpha(m.pngs?.[name]);
  }
  const ico = fs.readFileSync(path.join(root, 'assets/icon.ico'));
  if (ico.readUInt16LE(0) || ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== ICO_SIZES.length) fail('wrong ICO header');
  let end = 6 + ICO_SIZES.length * 16;
  for (let index = 0; index < ICO_SIZES.length; index++) {
    const offset = 6 + index * 16, size = ICO_SIZES[index];
    const width = ico[offset] || 256, height = ico[offset + 1] || 256;
    const length = ico.readUInt32LE(offset + 8), start = ico.readUInt32LE(offset + 12);
    if (width !== size || height !== size || ico[offset + 2] || ico[offset + 3] ||
        ico.readUInt16LE(offset + 4) !== 1 || ico.readUInt16LE(offset + 6) !== 32 ||
        start !== end || !length || start + length > ico.length) fail('wrong ICO frame table');
    png(ico.subarray(start, start + length), size); alpha(m.icoFrames?.[String(size)]);
    end = start + length;
  }
  if (end !== ico.length || !equal(Object.keys(m.icoFrames).map(Number).sort((a, b) => a - b), ICO_SIZES)) fail('wrong ICO sizes');
  const icns = fs.readFileSync(path.join(root, 'assets/icon.icns'));
  if (icns.toString('ascii', 0, 4) !== 'icns' || icns.readUInt32BE(4) !== icns.length) fail('wrong ICNS header');
  let offset = 8;
  const kinds = [];
  while (offset + 8 <= icns.length) {
    const kind = icns.toString('ascii', offset, offset + 4), length = icns.readUInt32BE(offset + 4);
    if (!ICNS_SIZES[kind] || kinds.includes(kind) || length < 8 || offset + length > icns.length) fail('wrong ICNS entry');
    png(icns.subarray(offset + 8, offset + length), ICNS_SIZES[kind]);
    if (m.icnsFrames?.[kind]?.size !== ICNS_SIZES[kind]) fail('wrong ICNS scale');
    alpha(m.icnsFrames[kind]); kinds.push(kind); offset += length;
  }
  if (offset !== icns.length || !equal(kinds, Object.keys(ICNS_SIZES))) fail('missing ICNS Retina sizes');
  const gif = fs.readFileSync(path.join(root, 'assets/installer.gif'));
  if (gif.toString('ascii', 0, 6) !== 'GIF89a' || gif.readUInt16LE(6) !== 256 ||
      gif.readUInt16LE(8) !== 256 || gif.at(-1) !== 0x3b) fail('invalid installer animation');
  return { verified: true, icoSizes: ICO_SIZES, icnsSizes: ICNS_SIZES, outputFiles: OUTPUTS,
    manifestSha256: hash(manifestBytes) };
}
module.exports = { verifyIcons };
if (require.main === module) {
  try { console.log(JSON.stringify(verifyIcons(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
