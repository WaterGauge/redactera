import assert from 'node:assert/strict';
import expected from '../../scripts/electron-runtime.json';
import pkg from '../../package.json';

export function verifyElectronRuntime(actual: { electron?: string; node?: string; chrome?: string }): void {
  assert.equal(expected.electron, pkg.devDependencies.electron, 'Electron runtime identity does not match package.json');
  for (const key of ['electron', 'node', 'chrome'] as const) {
    assert.equal(actual[key], expected[key], `Unexpected bundled ${key} version`);
  }
}
