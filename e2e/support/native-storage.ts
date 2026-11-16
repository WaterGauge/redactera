// Real Electron safeStorage and production SettingsManager; synthetic values only.
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createSettingsManager } from '../../src/main/settingsManager';
import { DEFAULT_SETTINGS } from '../../src/types/settings';
import { verifyElectronRuntime } from './runtime-identity';

const run = process.env.PDF_STORAGE_RUN as string;
const phase = process.env.PDF_STORAGE_PHASE as string;
assert(path.isAbsolute(run) && ['save', 'restart'].includes(phase));
const owner = JSON.parse(fs.readFileSync(path.join(run, 'owner.json'), 'utf8'));
assert(typeof owner.runId === 'string' && owner.run === run);
const profile = path.join(run, 'profile');
fs.mkdirSync(profile, { recursive: true });
app.setName('页隐凭据测试');
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-networking');

void app.whenReady().then(() => {
  const manager = createSettingsManager({ app, safeStorage });
  const fields = ['paddle_token', 'baidu_api_key', 'baidu_secret_key'] as const;
  const dummy = Object.fromEntries(fields.map(key => [key, 'synthetic-' + createHash('sha256').update(owner.runId + key).digest('hex')]));
  const file = manager.getSettingsPath();
  const report: Record<string, unknown> = { phase, realSafeStorage: true, realFileSystem: true,
    electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
    platform: process.platform, arch: process.arch, verified: false };
  const checkCipher = () => {
    const raw = fs.readFileSync(file, 'utf8'), disk = JSON.parse(raw);
    assert.equal(disk._encrypted, true);
    for (const key of fields) {
      assert(!raw.includes(dummy[key]) && !raw.includes(Buffer.from(dummy[key]).toString('base64')));
      assert(Buffer.from(disk[key], 'base64').length > 0);
    }
    assert(!('credential_read_id' in disk) && !('credential_storage_status' in disk));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    return raw;
  };
  try {
    verifyElectronRuntime(process.versions);
    report.encryptionAvailable = safeStorage.isEncryptionAvailable();
    assert(report.encryptionAvailable);
    if (phase === 'save') {
      manager.writeSettings({ ...DEFAULT_SETTINGS, ...dummy });
      checkCipher();
      report.encryptedWithoutPlaintext = true;
    } else {
      const loaded = manager.readSettings();
      report.loadedStorageStatus = loaded.credential_storage_status;
      report.credentialsMatchAfterRestart = fields.every(key => loaded[key] === dummy[key]);
      for (const key of fields) assert.equal(loaded[key], dummy[key]);
      assert.equal(loaded.credential_storage_status, 'available');
      const before = checkCipher();
      report.decryptedAfterRestart = true;
      const corrupted = JSON.parse(before);
      corrupted.paddle_token = Buffer.from('synthetic-invalid-ciphertext').toString('base64');
      fs.writeFileSync(file, JSON.stringify(corrupted));
      const badBytes = fs.readFileSync(file, 'utf8');
      const blocked = manager.readSettings();
      assert.equal(blocked.credential_storage_status, 'decrypt-error');
      for (const key of fields) assert.equal(blocked[key], '');
      assert.throws(() => manager.writeSettings({ ...blocked, export_dpi: 300 }));
      assert.equal(fs.readFileSync(file, 'utf8'), badBytes);
      report.corruptionBlocksOverwriteAndClearsAllCredentials = true;
      fs.writeFileSync(file, before);
      const recovered = manager.readSettings();
      for (const key of fields) assert.equal(recovered[key], dummy[key]);
      manager.writeSettings({ ...recovered, export_dpi: 300 });
      checkCipher();
      report.restoredCiphertextCanBeReadAndSaved = true;
    }
    report.verified = true;
  } catch {
    report.error = 'Native storage verification failed; no credential values are recorded';
    process.exitCode = 1;
  }
  fs.writeFileSync(path.join(run, phase + '.json'), JSON.stringify(report, null, 2));
  // Let Chromium flush native key metadata before the restart phase.
  process.exitCode = report.verified ? 0 : 1;
  app.quit();
}).catch(() => { process.exitCode = 1; app.quit(); });
