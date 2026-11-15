import { describe, expect, it, vi } from 'vitest';
import path from 'path';
import { createSettingsManager } from '../../main/settingsManager';
import { DEFAULT_SETTINGS, type AppSettings } from '../../types/settings';

const SECRET = 'SYNTHETIC_CREDENTIAL_DO_NOT_PERSIST';
const userData = path.resolve('synthetic', 'userData');
const location = path.join(userData, 'settings.json');
const keys = ['paddle_token', 'baidu_api_key', 'baidu_secret_key'] as const;
const settings = (overrides: Partial<AppSettings> = {}): AppSettings => ({ ...DEFAULT_SETTINGS, ...overrides });
const encrypted = () => ({ ...settings({ export_dpi: 300, developer_mode: true }),
  ...Object.fromEntries(keys.map(key => [key, Buffer.from(`enc:${SECRET}-${key}`).toString('base64')])), _encrypted: true });

function harness(initial?: unknown, available = true, platform = 'darwin') {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set(location, JSON.stringify(initial));
  const handles = new Map<number, string>();
  const readFile = (file: string): string => {
    const body = files.get(file);
    if (body === undefined) throw Object.assign(new Error('synthetic missing file'), { code: 'ENOENT' });
    return body;
  };
  let nextHandle = 10;
  const state = { available, backend: 'gnome_libsecret', decryptError: false, encryptError: false,
    readError: false, writeError: false, renameError: false };
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => state.available),
    getSelectedStorageBackend: vi.fn(() => state.backend),
    encryptString: vi.fn((plain: string) => {
      if (state.encryptError) throw new Error(SECRET);
      return Buffer.from(`enc:${plain}`);
    }),
    decryptString: vi.fn((bytes: Buffer) => {
      if (state.decryptError || !bytes.toString().startsWith('enc:')) throw new Error(SECRET);
      return bytes.toString().slice(4);
    }),
  };
  const fsImpl = {
    readFileSync: vi.fn((file: string) => {
      if (state.readError) throw new Error(SECRET);
      return readFile(file);
    }),
    openSync: vi.fn((file: string, flag: string, mode: number) => {
      expect(flag).toBe('wx'); expect(mode).toBe(0o600);
      if (files.has(file)) throw Object.assign(new Error('synthetic collision'), { code: 'EEXIST' });
      files.set(file, ''); handles.set(++nextHandle, file); return nextHandle;
    }),
    writeFileSync: vi.fn((file: string | number, body: string) => {
      const target = typeof file === 'number' ? handles.get(file) : file;
      if (!target) throw new Error('synthetic unknown handle');
      files.set(target, state.writeError ? body.slice(0, 12) : body);
      if (state.writeError) throw new Error(SECRET);
    }),
    fsyncSync: vi.fn(),
    closeSync: vi.fn((handle: number) => { handles.delete(handle); }),
    renameSync: vi.fn((from: string, to: string) => {
      if (state.renameError) throw new Error(SECRET);
      files.set(to, readFile(from)); files.delete(from);
    }),
    unlinkSync: vi.fn((file: string) => { files.delete(file); }),
  };
  const manager = createSettingsManager({ app: { getPath: () => userData }, safeStorage,
    fsImpl, platform } as unknown as Parameters<typeof createSettingsManager>[0]);
  return { manager, state, safeStorage, fsImpl, files,
    get raw() { return files.get(location); },
    get stored() { return JSON.parse(readFile(location)); },
    read: () => manager.readSettings() as AppSettings & Record<string, unknown> };
}

describe('real settings manager credential boundary', () => {
  it.each([undefined, encrypted()])('loads preferences without querying or unlocking secure storage', initial => {
    const h = harness(initial, false);
    const before = h.raw;
    const preferences = h.manager.readPreferences();
    expect(preferences.export_dpi).toBe(initial ? 300 : 150);
    expect(preferences.credential_read_id).toEqual(expect.any(String));
    expect(preferences.has_saved_credentials).toBe(Boolean(initial));
    for (const key of keys) expect(preferences[key]).toBe('');
    expect(h.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(h.safeStorage.decryptString).not.toHaveBeenCalled();
    expect(h.raw).toBe(before);
    if (initial) {
      h.state.available = true;
      expect(h.read().paddle_token).toBe(`${SECRET}-paddle_token`);
    }
  });

  it.each([encrypted(), settings({ paddle_token: SECRET })])('saves ordinary preferences while retaining opaque stored credentials', initial => {
    const h = harness(initial, false);
    h.state.decryptError = true;
    const preferences = h.manager.readPreferences();
    h.manager.writePreferences({ ...preferences, export_dpi: 200 });
    expect(h.stored.export_dpi).toBe(200);
    for (const key of keys) expect(h.stored[key]).toBe(initial[key]);
    expect(h.stored._encrypted).toBe('_encrypted' in initial ? initial._encrypted : undefined);
    expect(h.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(h.safeStorage.encryptString).not.toHaveBeenCalled();
    expect(h.safeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('rejects a stale preference receipt before writing over another update', () => {
    const h = harness(encrypted(), false);
    const draft = h.manager.readPreferences();
    h.files.set(location, JSON.stringify({ ...encrypted(), export_dpi: 200 }));
    const before = h.raw;
    expect(() => h.manager.writePreferences({ ...draft, export_dpi: 150 })).toThrow('设置已变更');
    expect(h.raw).toBe(before);
    expect(h.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
  });

  it('does not use a preference-only receipt to erase saved credentials', () => {
    const h = harness(encrypted());
    const draft = h.manager.readPreferences();
    h.read();
    const before = h.raw;
    expect(() => h.manager.writeSettings(draft)).toThrow();
    expect(h.raw).toBe(before);
  });

  it('preserves an unreadable file when saving preferences', () => {
    const h = harness(encrypted(), false);
    h.state.readError = true;
    const draft = h.manager.readPreferences();
    const before = h.raw;
    expect(() => h.manager.writePreferences(draft)).toThrow();
    expect(h.raw).toBe(before);
    expect(h.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'])('reads a v1.2.0 settings file on %s without rewriting it', platform => {
    const legacy = {
      ocr_mode: 'paddle', paddle_api_url: 'https://ocr.example.invalid/layout-parsing',
      ocr_language: 'chi_tra+eng', export_dpi: 300, fuzzy_match_enabled: true,
      fuzzy_match_threshold: 0.7, developer_mode: false, log_folder_path: '',
      ...Object.fromEntries(keys.map(key => [key, Buffer.from(`enc:${SECRET}-${key}`).toString('base64')])),
      _encrypted: true,
    };
    const h = harness(legacy, true, platform);
    const value = h.read();
    expect(value).toMatchObject({
      ocr_mode: 'paddle', ocr_language: 'chi_tra+eng', export_dpi: 300, fuzzy_match_enabled: true,
      redaction_scope: DEFAULT_SETTINGS.redaction_scope, credential_storage_status: 'available',
    });
    for (const key of keys) expect(value[key]).toBe(`${SECRET}-${key}`);
    expect(h.raw).toBe(JSON.stringify(legacy));
    expect(h.fsImpl.writeFileSync).not.toHaveBeenCalled();
  });

  it.each(keys)('does not persist %s when secure storage is unavailable', key => {
    const h = harness(undefined, false);
    expect(() => h.manager.writeSettings(settings({ [key]: SECRET }))).toThrow();
    expect(h.fsImpl.writeFileSync).not.toHaveBeenCalled();
    expect(h.raw).toBeUndefined();
  });

  it('returns preferences and an explicit locked state without ciphertext', () => {
    const h = harness(encrypted(), false);
    const value = h.read();
    expect(value).toMatchObject({ export_dpi: 300, developer_mode: true, credential_storage_status: 'locked' });
    for (const key of keys) expect(value[key]).toBe('');
    expect(value).not.toHaveProperty('_encrypted');
    expect(h.fsImpl.writeFileSync).not.toHaveBeenCalled();
  });

  it('never partially releases credentials if one decrypt fails', () => {
    const h = harness(encrypted());
    h.safeStorage.decryptString.mockImplementationOnce(bytes => bytes.toString().slice(4))
      .mockImplementationOnce(() => { throw new Error(SECRET); });
    const value = h.read();
    expect(value.credential_storage_status).toBe('decrypt-error');
    for (const key of keys) expect(value[key]).toBe('');
    expect(JSON.stringify(value)).not.toContain(SECRET);
  });

  it.each([true, false])('rejects raw disk marker %s at the write entry', marker => {
    const h = harness();
    expect(() => h.manager.writeSettings({ ...settings({ paddle_token: SECRET }), _encrypted: marker } as AppSettings)).toThrow();
    expect(h.fsImpl.writeFileSync).not.toHaveBeenCalled();
  });

  it.each(['true', 1, {}])('does not decrypt a non-boolean disk marker (%j)', marker => {
    const h = harness({ ...encrypted(), _encrypted: marker });
    expect(h.read().credential_storage_status).toBe('read-error');
    expect(h.safeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('does not let an internal successful read unlock an old masked UI snapshot', () => {
    const h = harness(encrypted(), false);
    const masked = h.read(); const before = h.raw;
    h.state.available = true;
    expect(h.read().paddle_token).toContain(SECRET); // Main logger/preference read.
    expect(() => h.manager.writeSettings({ ...masked, developer_mode: false })).toThrow();
    expect(h.raw).toBe(before);
    expect(h.fsImpl.writeFileSync).not.toHaveBeenCalled();
    const retry = h.read();
    h.manager.writeSettings({ ...retry, developer_mode: false });
    expect(h.read().paddle_token).toContain(SECRET);
  });

  it('cannot bypass a protected-file write by stripping the read receipt', () => {
    const h = harness(encrypted(), false);
    const value = h.read(); const before = h.raw; h.state.available = true;
    delete value.credential_storage_status; delete value.credential_read_id; delete value._encrypted;
    expect(() => h.manager.writeSettings(value)).toThrow();
    expect(h.raw).toBe(before);
  });

  it('does not trust a forged available status on a blocked read receipt', () => {
    const h = harness(encrypted(), false); const value = h.read(); const before = h.raw;
    h.state.available = true;
    expect(() => h.manager.writeSettings({ ...value, credential_storage_status: 'available' })).toThrow();
    expect(h.raw).toBe(before);
  });

  it('rejects a stale draft if the settings file changed after it was read', () => {
    const h = harness(encrypted()); const value = h.read();
    h.files.set(location, JSON.stringify({ ...encrypted(), redaction_scope: 'paragraph' })); const before = h.raw;
    expect(() => h.manager.writeSettings(value)).toThrow();
    expect(h.raw).toBe(before);
  });

  it('does not pass malformed base64 to the decryptor or return it as plaintext', () => {
    const h = harness({ ...encrypted(), paddle_token: 'not base64 %%%' });
    const value = h.read();
    expect(value.credential_storage_status).toBe('decrypt-error');
    for (const key of keys) expect(value[key]).toBe('');
    expect(h.safeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('keeps legacy plaintext visible as a migration state and encrypts only on save', () => {
    const h = harness(settings({ paddle_token: SECRET, export_dpi: 300 }));
    const legacy = h.read();
    expect(legacy.credential_storage_status).toBe('legacy');
    expect(legacy.paddle_token).toBe(SECRET);
    expect(h.fsImpl.writeFileSync).not.toHaveBeenCalled();
    h.manager.writeSettings(legacy);
    expect(h.raw).not.toContain(SECRET);
    expect(h.stored._encrypted).toBe(true);
    expect(h.read()).toMatchObject({ paddle_token: SECRET, export_dpi: 300 });
  });

  it('preserves an old plaintext record when migration encryption fails', () => {
    const h = harness(settings({ paddle_token: SECRET }));
    const value = h.read(); const before = h.raw; h.state.encryptError = true;
    let message = ''; try { h.manager.writeSettings(value); } catch (error) { message = String(error); }
    expect(message).toBeTruthy(); expect(message).not.toContain(SECRET);
    expect(h.raw).toBe(before); expect(h.fsImpl.writeFileSync).not.toHaveBeenCalled();
  });

  it('does not write when encryption fails after another credential succeeded', () => {
    const h = harness();
    h.safeStorage.encryptString.mockImplementationOnce(value => Buffer.from(`enc:${value}`))
      .mockImplementationOnce(() => { throw new Error(SECRET); });
    expect(() => h.manager.writeSettings(settings({ paddle_token: SECRET, baidu_api_key: SECRET }))).toThrow();
    expect(h.fsImpl.writeFileSync).not.toHaveBeenCalled();
    expect(h.raw).toBeUndefined();
  });

  it.each(['writeError', 'renameError'] as const)('preserves the original if migration %s occurs', failure => {
    const h = harness(settings({ paddle_token: SECRET }));
    const value = h.read(); const before = h.raw; h.state[failure] = true;
    expect(() => h.manager.writeSettings(value)).toThrow();
    expect(h.raw).toBe(before);
    expect([...h.files.keys()]).toEqual([location]);
  });

  it.each(['openSync', 'fsyncSync', 'closeSync'] as const)('keeps the original if staging %s fails', operation => {
    const h = harness(settings({ paddle_token: SECRET })); const value = h.read(); const before = h.raw;
    h.fsImpl[operation].mockImplementationOnce(() => { throw new Error(SECRET); });
    expect(() => h.manager.writeSettings(value)).toThrow('设置保存失败');
    expect(h.raw).toBe(before);
    expect(h.fsImpl.renameSync).not.toHaveBeenCalled();
    if (operation === 'openSync') expect(h.fsImpl.unlinkSync).not.toHaveBeenCalled();
  });

  it('does not expose plaintext if encrypted staging cleanup also fails', () => {
    const h = harness(settings({ paddle_token: SECRET })); const value = h.read(); const before = h.raw;
    h.state.writeError = true;
    h.fsImpl.unlinkSync.mockImplementationOnce(() => { throw new Error(SECRET); });
    expect(() => h.manager.writeSettings(value)).toThrow('设置保存失败');
    expect(h.raw).toBe(before);
    for (const [name, body] of h.files) if (name !== location) expect(body).not.toContain(SECRET);
  });

  it('does not persist unknown copies or runtime metadata', () => {
    const h = harness();
    h.manager.writeSettings({ ...settings({ paddle_token: SECRET }),
      credential_storage_status: 'available', nested: { token: SECRET }, copied_secret: SECRET } as AppSettings);
    expect(h.raw).not.toContain(SECRET);
    expect(h.stored).not.toHaveProperty('nested');
    expect(h.stored).not.toHaveProperty('credential_storage_status');
    expect(h.stored).not.toHaveProperty('credential_read_id');
  });

  it('keeps empty non-secret preferences usable without secure storage', () => {
    const h = harness(undefined, false);
    h.manager.writeSettings(settings({ export_dpi: 300, developer_mode: true }));
    expect(h.stored.export_dpi).toBe(300);
    expect(h.stored._encrypted).toBeUndefined();
  });

  it('does not mistake the Linux basic_text backend for secure storage', () => {
    const h = harness(undefined, true, 'linux'); h.state.backend = 'basic_text';
    expect(() => h.manager.writeSettings(settings({ paddle_token: SECRET }))).toThrow();
    expect(h.fsImpl.writeFileSync).not.toHaveBeenCalled();
  });

  it('preserves malformed or unreadable records and blocks default overwrite', () => {
    const h = harness({ ...encrypted(), export_dpi: 999 }); const before = h.raw;
    const invalid = h.read();
    expect(invalid.credential_storage_status).toBe('read-error');
    expect(() => h.manager.writeSettings(invalid)).toThrow();
    expect(h.raw).toBe(before);
    h.state.readError = true;
    expect(h.read().credential_storage_status).toBe('read-error');
    expect(() => h.manager.writeSettings(settings())).toThrow();
    expect(h.raw).toBe(before);
  });
});
