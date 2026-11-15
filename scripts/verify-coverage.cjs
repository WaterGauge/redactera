const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const coverage = path.resolve(root, process.argv[2] || 'coverage');
function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__tests__') return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && /\.(ts|tsx)$/.test(entry.name) &&
      !/\.d\.ts$|\.(test|spec)\.(ts|tsx)$/.test(entry.name) ? [file] : [];
  });
}

try {
  const expected = sourceFiles(path.join(root, 'src'));
  const data = JSON.parse(fs.readFileSync(path.join(coverage, 'coverage-final.json'), 'utf8'));
  const summary = JSON.parse(fs.readFileSync(path.join(coverage, 'coverage-summary.json'), 'utf8'));
  const lcov = fs.readFileSync(path.join(coverage, 'lcov.info'), 'utf8');
  const reported = new Map(Object.entries(data).map(([file, value]) => [path.resolve(root, file), value]));
  const lcovFiles = new Set(lcov.split(/\r?\n/).filter(line => line.startsWith('SF:')).map(line => path.resolve(root, line.slice(3))));
  if (!expected.length) throw Error('No production source files found');
  for (const file of expected) {
    const value = reported.get(file);
    if (!value || path.resolve(value.path) !== file || !value.statementMap || !value.s || !value.f || !value.b || !summary[file]) {
      throw Error(`Missing source coverage: ${path.relative(root, file)}`);
    }
    if (!lcovFiles.has(file)) throw Error(`Missing LCOV source: ${path.relative(root, file)}`);
  }
  if (reported.size !== expected.length || lcovFiles.size !== expected.length) throw Error('Coverage includes unexpected files');
  for (const metric of ['statements', 'branches', 'functions', 'lines']) {
    const result = summary.total?.[metric];
    if (!result || !Number.isFinite(result.total) || !Number.isFinite(result.covered) || !Number.isFinite(result.pct) ||
        result.total < 0 || result.covered < 0 || result.covered > result.total || result.pct < 0 || result.pct > 100) {
      throw Error(`Invalid coverage total: ${metric}`);
    }
  }
  console.log(JSON.stringify({ sourceFiles: expected.length, lcovFiles: lcovFiles.size,
    total: summary.total, entries: Object.fromEntries(['index.ts', 'preload.ts', 'renderer.tsx'].map(name =>
      [name, summary[path.join(root, 'src', name)]])) }, null, 2));
} catch (error) {
  console.error(`Coverage verification failed: ${error.message}`);
  process.exitCode = 1;
}
