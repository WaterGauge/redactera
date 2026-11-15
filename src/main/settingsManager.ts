import fs from 'fs';
import https from 'https';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { App, SafeStorage } from 'electron';
import { CREDENTIAL_STORAGE_MESSAGES, credentialStorageBlocked, DEFAULT_SETTINGS,
  type AppSettings, type CredentialStorageStatus } from '../types/settings';
import { validateSettings } from '../utils/validation';

interface SettingsManagerDependencies {
  app: Pick<App, 'getPath'>;
  safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'> &
    Partial<Pick<SafeStorage, 'getSelectedStorageBackend'>>;
  fsImpl?: Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'openSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'unlinkSync'>;
  httpsImpl?: Pick<typeof https, 'request'>;
  platform?: NodeJS.Platform;
}

export interface SettingsManager {
  getSettingsPath(): string;
  readPreferences(): AppSettings;
  readSettings(): AppSettings;
  writeSettings(settings: AppSettings): void;
  writePreferences(settings: AppSettings): void;
  validateBaiduKeys(apiKey: string, secretKey: string): Promise<boolean>;
}

function decryptCredential(
  safeStorage: Pick<SafeStorage, 'decryptString'>,
  value: string
): string {
  if (!value) return '';
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value) throw new Error('Invalid credential encoding');
  return safeStorage.decryptString(buffer);
}

function encryptCredential(
  safeStorage: Pick<SafeStorage, 'encryptString'>,
  value: string
): string {
  if (!value) return '';
  const encrypted = safeStorage.encryptString(value);
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('Invalid encrypted credential');
  return encrypted.toString('base64');
}

const CREDENTIAL_KEYS = ['paddle_token', 'baidu_api_key', 'baidu_secret_key'] as const;
type StoredSettings = Omit<AppSettings, 'credential_storage_status' | 'credential_read_id'> & { _encrypted?: boolean };

function persistentSettings(settings: AppSettings): StoredSettings {
  // Explicit persistent fields exclude metadata, markers and unknown copies.
  return { ocr_mode: settings.ocr_mode, paddle_api_url: settings.paddle_api_url,
    paddle_token: settings.paddle_token, baidu_api_key: settings.baidu_api_key,
    baidu_secret_key: settings.baidu_secret_key, ocr_language: settings.ocr_language,
    export_dpi: settings.export_dpi, fuzzy_match_enabled: settings.fuzzy_match_enabled,
    fuzzy_match_threshold: settings.fuzzy_match_threshold, redaction_scope: settings.redaction_scope,
    developer_mode: settings.developer_mode, log_folder_path: settings.log_folder_path };
}

function withoutCredentials(settings: AppSettings): AppSettings {
  const preferences = { ...settings };
  for (const key of CREDENTIAL_KEYS) preferences[key] = '';
  return preferences;
}

interface DiskState {
  settings: AppSettings;
  revision: string;
  encrypted: boolean;
  readError: boolean;
}

interface ReadState {
  settings: AppSettings;
  status: CredentialStorageStatus;
  revision: string;
  hasCredentials: boolean;
}

export function createSettingsManager({
  app,
  safeStorage,
  fsImpl = fs,
  httpsImpl = https,
  platform = process.platform,
}: SettingsManagerDependencies): SettingsManager {
  const getSettingsPath = (): string => path.join(app.getPath('userData'), 'settings.json');
  const reads = new Map<string, { status?: CredentialStorageStatus; revision: string; credentialsLoaded: boolean }>();

  const rememberRead = (revision: string, status: CredentialStorageStatus | undefined, credentialsLoaded: boolean): string => {
    const id = randomUUID();
    if (reads.size >= 64) reads.delete(reads.keys().next().value as string);
    reads.set(id, { status, revision, credentialsLoaded });
    return id;
  };

  const secureStorageAvailable = (): boolean => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      return platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']
        .includes(safeStorage.getSelectedStorageBackend?.() ?? 'unknown');
    } catch { return false; }
  };

  const readDisk = (): DiskState => {
    let raw: string;
    try {
      raw = fsImpl.readFileSync(getSettingsPath(), 'utf-8');
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
      return { settings: { ...DEFAULT_SETTINGS }, revision: missing ? 'missing' : 'unreadable',
        encrypted: false, readError: !missing };
    }

    const revision = createHash('sha256').update(raw).digest('hex');
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings');
      const merged: StoredSettings = { ...DEFAULT_SETTINGS, ...parsed };
      // Validate the disk marker before interpreting or discarding it.
      if (!validateSettings(merged)) throw new Error('Invalid settings');
      return { settings: persistentSettings(merged), revision, encrypted: merged._encrypted === true, readError: false };
    } catch {
      return { settings: { ...DEFAULT_SETTINGS }, revision, encrypted: false, readError: true };
    }
  };

  const readPreferences = (): AppSettings => {
    const state = readDisk();
    const status = state.readError ? 'read-error' : undefined;
    return { ...withoutCredentials(state.settings), credential_storage_status: status,
      credential_read_id: rememberRead(state.revision, status, false),
      has_saved_credentials: CREDENTIAL_KEYS.some(key => state.settings[key] !== '') };
  };

  const readStored = (): ReadState => {
    const { settings, revision, encrypted, readError } = readDisk();
    if (readError) return { settings, revision, status: 'read-error', hasCredentials: false };
    const hasCredentials = CREDENTIAL_KEYS.some(key => settings[key] !== '');
    const available = secureStorageAvailable();
    if (encrypted && hasCredentials) {
      if (!available) return { settings: withoutCredentials(settings), status: 'locked', revision, hasCredentials };
      try {
        const decrypted = CREDENTIAL_KEYS.map(key => decryptCredential(safeStorage, settings[key]));
        CREDENTIAL_KEYS.forEach((key, index) => { settings[key] = decrypted[index]; });
      } catch {
        return { settings: withoutCredentials(settings), status: 'decrypt-error', revision, hasCredentials };
      }
    }
    return { settings, status: hasCredentials && !encrypted ? 'legacy' : available ? 'available' : 'unavailable',
      revision, hasCredentials };
  };

  const readSettings = (): AppSettings => {
    const state = readStored();
    return { ...state.settings, credential_storage_status: state.status,
      credential_read_id: rememberRead(state.revision, state.status, true),
      has_saved_credentials: state.hasCredentials };
  };

  const replaceSettings = (serialized: string): void => {
    const temporary = path.join(path.dirname(getSettingsPath()), `.settings-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    let created = false;
    let published = false;
    try {
      descriptor = fsImpl.openSync(temporary, 'wx', 0o600);
      created = true;
      fsImpl.writeFileSync(descriptor, serialized, 'utf-8');
      fsImpl.fsyncSync(descriptor);
      const closing = descriptor;
      descriptor = undefined;
      fsImpl.closeSync(closing);
      fsImpl.renameSync(temporary, getSettingsPath());
      published = true;
    } catch {
      throw new Error('设置保存失败，原设置已保留。请检查目录权限和磁盘空间后重试。');
    } finally {
      if (descriptor !== undefined) { try { fsImpl.closeSync(descriptor); } catch { /* Keep the original file. */ } }
      if (created && !published) { try { fsImpl.unlinkSync(temporary); } catch { /* Only encrypted staging may remain. */ } }
    }
  };

  const writeSettings = (settings: AppSettings): void => {
    if (!validateSettings(settings) || '_encrypted' in settings) {
      throw new Error('Invalid settings format');
    }

    const current = readStored();
    if (credentialStorageBlocked(current.status)) throw new Error(CREDENTIAL_STORAGE_MESSAGES[current.status]);
    const receipt = settings.credential_read_id ? reads.get(settings.credential_read_id) : undefined;
    if (credentialStorageBlocked(settings.credential_storage_status) ||
        (settings.credential_read_id !== undefined && (!receipt || credentialStorageBlocked(receipt.status) || receipt.revision !== current.revision)) ||
        (current.hasCredentials && !receipt?.credentialsLoaded)) {
      throw new Error('设置已变更或凭证未成功载入，请重新读取设置后再保存。');
    }

    const toSave = persistentSettings(settings);
    if (CREDENTIAL_KEYS.some(key => settings[key] !== '')) {
      if (!secureStorageAvailable()) throw new Error(CREDENTIAL_STORAGE_MESSAGES.unavailable);
      try {
        for (const key of CREDENTIAL_KEYS) toSave[key] = encryptCredential(safeStorage, settings[key]);
      } catch {
        throw new Error('凭证加密失败，设置未保存。请解锁系统安全存储后重试。');
      }
      toSave._encrypted = true;
    }

    replaceSettings(JSON.stringify(toSave, null, 2));
  };

  const writePreferences = (settings: AppSettings): void => {
    if (!validateSettings(settings) || '_encrypted' in settings) throw new Error('Invalid settings format');
    const current = readDisk();
    if (current.readError) throw new Error(CREDENTIAL_STORAGE_MESSAGES['read-error']);
    const receipt = settings.credential_read_id ? reads.get(settings.credential_read_id) : undefined;
    if (!receipt || receipt.status === 'read-error' || receipt.revision !== current.revision) {
      throw new Error('设置已变更，请重新读取后再保存。');
    }
    const toSave = persistentSettings(settings);
    // Ordinary preferences preserve the stored credential bytes without decrypting.
    for (const key of CREDENTIAL_KEYS) toSave[key] = current.settings[key];
    if (current.encrypted) toSave._encrypted = true;
    replaceSettings(JSON.stringify(toSave, null, 2));
  };

  const validateBaiduKeys = (apiKey: string, secretKey: string): Promise<boolean> =>
    new Promise((resolve) => {
      const body = new URLSearchParams({
        grant_type: 'client_credentials', client_id: apiKey, client_secret: secretKey,
      }).toString();
      const request = httpsImpl.request('https://aip.baidubce.com/oauth/2.0/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (response) => {
        let data = '';
        response.on('data', (chunk: Buffer | string) => {
          data += chunk.toString();
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { access_token?: string };
            resolve(Boolean(parsed.access_token));
          } catch {
            resolve(false);
          }
        });
      });

      request.on('error', () => resolve(false));
      request.setTimeout(10000, () => {
        request.destroy();
        resolve(false);
      });
      request.end(body);
    });

  return {
    getSettingsPath,
    readPreferences,
    readSettings,
    writeSettings,
    writePreferences,
    validateBaiduKeys,
  };
}
