const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  if (entry.name === '__pycache__') return [];
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
});
function snapshot(root, files) {
  const hashes = Object.fromEntries(files.sort().map(file => [path.relative(root, file).split(path.sep).join('/'), digest(fs.readFileSync(file))]));
  return { sha256: digest(JSON.stringify(hashes)), files: hashes };
}
exports.sourceSnapshot = root => snapshot(root, [
  ...['src', 'e2e', 'scripts'].flatMap(directory => walk(path.join(root, directory))),
  ...fs.readdirSync(path.join(root, 'python-backend')).filter(name => /\.(py|spec|txt)$/.test(name)).map(name => path.join(root, 'python-backend', name)),
  ...['package.json', 'package-lock.json', 'forge.config.ts', 'wdio.conf.ts', 'tsconfig.json', 'tsconfig.e2e.json', 'tsconfig.build.json',
    '.eslintrc.json', '.github/workflows/build-release.yml', 'webpack.main.config.ts', 'webpack.renderer.config.ts', 'webpack.rules.ts', 'webpack.plugins.ts', 'webpack.pdf-assets.ts', '.github/workflows/test.yml']
    .map(name => path.join(root, name)),
]);
exports.directorySnapshot = directory => snapshot(directory, walk(directory));
