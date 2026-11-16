import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';
import lock from '../../../package-lock.json';
import expected from '../../../scripts/electron-runtime.json';
import { verifyElectronRuntime } from '../../../e2e/support/runtime-identity';

describe('bundled Electron runtime identity', () => {
  it('pins the same Electron release in the package, npm lock and runtime identity', () => {
    expect(expected.electron).toBe(pkg.devDependencies.electron);
    expect(lock.packages[''].devDependencies.electron).toBe(expected.electron);
    expect(lock.packages['node_modules/electron'].version).toBe(expected.electron);
    expect(expected.node).toMatch(/^\d+\.\d+\.\d+$/);
    expect(expected.chrome).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(() => verifyElectronRuntime(expected)).not.toThrow();
  });
  it.each(['electron', 'node', 'chrome'] as const)('rejects a missing or mismatched %s runtime independently', key => {
    expect(() => verifyElectronRuntime({ ...expected, [key]: undefined })).toThrow();
    expect(() => verifyElectronRuntime({ ...expected, [key]: '0.0.0' })).toThrow();
  });
});
