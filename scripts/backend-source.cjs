// Canonical backend input inventory; keep in sync with python-backend/source_inventory.py.
const fs = require('node:fs');
const path = require('node:path');

const rootExcluded = new Set(['tests', 'build', 'dist', 'coverage', 'htmlcov', 'venv', 'env',
  'node_modules', 'tmp', 'temp', 'logs', 'coverage.xml']);
const portableName = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?![\s\S])/;
const windowsDevice = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;

function excluded(name, atRoot) {
  const folded = name.toLowerCase();
  return name.startsWith('.') || folded === '__pycache__' || folded.endsWith('.pyc') || folded.endsWith('.pyo') ||
    (atRoot && rootExcluded.has(folded));
}

function regularInfo(file) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink()) throw Error('Linked backend source is not supported');
  return info;
}

function backendFiles(root) {
  const base = path.join(root, 'python-backend');
  if (!regularInfo(base).isDirectory()) throw Error('Backend source root is not a directory');
  const files = [];
  const seen = new Set();
  const visit = directory => {
    for (const name of fs.readdirSync(directory)) {
      if (excluded(name, directory === base)) continue;
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (!portableName.test(name) || name.endsWith('.') || windowsDevice.test(name.split('.')[0])) {
        throw Error('Non-portable backend source name: ' + relative);
      }
      const key = relative.toLowerCase();
      if (seen.has(key)) throw Error('Case-colliding backend source name: ' + relative);
      seen.add(key);
      const info = regularInfo(file);
      if (info.isDirectory()) visit(file);
      else if (info.isFile()) files.push(relative);
      else throw Error('Non-regular backend source entry: ' + relative);
    }
  };
  visit(base);
  return files.sort();
}

module.exports = { backendFiles };
