import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureDesktopProfile, desktopDistribution, planStoreProfile } from './distribution';
import { createSettingsManager } from './settingsManager';
import { registerIpcHandlers } from './ipcHandlers';
import { DEFAULT_SETTINGS } from '../types/settings';
import { createFileSession } from './sessionFiles';

const family = 'Example.Redactera_abcdefghijklm';
const store = { expectedFamily: family, nativeFamily: family,
  canonicalLocalState: `C:\\Users\\Test\\AppData\\Local\\Packages\\${family}\\LocalState`,
  legacyUserData: 'C:\\Users\\Test\\AppData\\Roaming\\PDF Desensitization',
  legacySessionData: 'C:\\Users\\Test\\AppData\\Roaming\\PDF Desensitization' };

afterEach(() => vi.unstubAllGlobals());

describe('distribution boundaries', () => {
  it.each([undefined, false])('preserves the desktop runtime for %s', marker => {
    const context = desktopDistribution({ windowsStore: marker, mas: marker });
    expect(context).toEqual({ channel: 'github', updateAuthority: 'github-manual' });
    expect(Object.isFrozen(context)).toBe(true);
  });
  it.each([true, 'false', null, 0, {}])('rejects unsupported or invalid package markers %s', marker => {
    expect(desktopDistribution({ windowsStore: marker, mas: undefined })).toBeNull();
    expect(desktopDistribution({ windowsStore: undefined, mas: marker })).toBeNull();
  });
  it('plans independent Store directories only for the exact approved native family', () => {
    const profile = planStoreProfile(store);
    expect(profile.userData).toBe(store.canonicalLocalState + '\\Redactera');
    expect(profile.sessionData).toBe(profile.userData + '\\chromium');
    expect(profile.fileSessions).toBe(profile.userData + '\\file-sessions');
    expect(Object.isFrozen(profile)).toBe(true);
  });
  it.each([
    { nativeFamily: 'Other.Redactera_abcdefghijklm' },
    { expectedFamily: '' },
    { canonicalLocalState: 'C:\\Users\\Test\\AppData\\LocalState' },
    { canonicalLocalState: store.canonicalLocalState + '\\..\\LocalState' },
    { canonicalLocalState: '\\\\server\\share\\' + family + '\\LocalState' },
    { canonicalLocalState: 'C:\\CON\\' + family + '\\LocalState' },
    { legacyUserData: store.canonicalLocalState.toUpperCase() },
    { legacySessionData: store.canonicalLocalState + '\\Redactera\\chromium' },
    { legacyUserData: 'C:\\Users\\Test\\AppData\\Local\\Packages' },
    { legacyUserData: 'relative' },
  ])('rejects ambiguous or overlapping Store profile plans %j', override => {
    expect(() => planStoreProfile({ ...store, ...override })).toThrow();
  });
  it('preserves the actual desktop profile and pins settings before any later path change', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redactera-channel-'));
    try {
      const legacy = path.join(root, 'legacy'), other = path.join(root, 'other');
      fs.mkdirSync(legacy); fs.mkdirSync(other);
      const profile = captureDesktopProfile(legacy, legacy);
      expect(profile.fileSessions).toBe(path.join(legacy, 'file-sessions'));
      expect(Object.isFrozen(profile)).toBe(true);
      const app = { getPath: vi.fn(() => other) };
      const safeStorage = { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() };
      const manager = createSettingsManager({ app, safeStorage, profileDirectory: profile.userData });
      const preferences = manager.readPreferences();
      manager.writePreferences({ ...preferences, export_dpi: 300 });
      expect(manager.getSettingsPath()).toBe(path.join(legacy, 'settings.json'));
      expect(fs.existsSync(path.join(legacy, 'settings.json'))).toBe(true);
      expect(fs.readdirSync(other)).toEqual([]);
      expect(app.getPath).not.toHaveBeenCalled();
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
      expect(createSettingsManager({ app, safeStorage, profileDirectory: other }).readPreferences().export_dpi).toBe(DEFAULT_SETTINGS.export_dpi);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('does not copy encrypted credentials or recover sessions across independent roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redactera-channel-'));
    try {
      const legacy = path.join(root, 'legacy'), other = path.join(root, 'other');
      fs.mkdirSync(legacy); fs.mkdirSync(other);
      const app = { getPath: vi.fn(() => legacy) };
      const safeStorage = { isEncryptionAvailable: () => true,
        encryptString: vi.fn((v: string) => Buffer.from('synthetic:' + v)),
        decryptString: vi.fn((v: Buffer) => v.toString().slice('synthetic:'.length)) };
      const one = createSettingsManager({ app, safeStorage, platform: 'win32', profileDirectory: legacy });
      const two = createSettingsManager({ app, safeStorage, platform: 'win32', profileDirectory: other });
      one.writeSettings({ ...one.readSettings(), paddle_token: 'synthetic-test-token' });
      const saved = fs.readFileSync(one.getSettingsPath(), 'utf8');
      expect(saved).not.toContain('synthetic-test-token');
      expect(two.readSettings().paddle_token).toBe('');
      expect(safeStorage.decryptString).not.toHaveBeenCalled();
      expect(one.readSettings().paddle_token).toBe('synthetic-test-token');
      two.writePreferences({ ...two.readPreferences(), export_dpi: 300 });
      expect(fs.readFileSync(one.getSettingsPath(), 'utf8')).toBe(saved);
      expect(() => createSettingsManager({ app, safeStorage, profileDirectory: 'relative' })).toThrow();
      const first = createFileSession({ baseDirectory: path.join(legacy, 'file-sessions'), platform: 'linux' });
      const second = createFileSession({ baseDirectory: path.join(other, 'file-sessions'), platform: 'linux' });
      const privateFile = path.join(first.directory, 'synthetic.pdf');
      fs.writeFileSync(privateFile, 'synthetic');
      // Reserved session paths are protected from final-save across profiles, not owned for deletion.
      expect(second.isManagedPath(privateFile)).toBe(true);
      expect(second.cleanup()).toBe(true);
      expect(fs.readFileSync(privateFile, 'utf8')).toBe('synthetic');
      expect(first.cleanup()).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['system-managed', undefined, 'unknown'])('blocks all legacy update aliases in mode %s', async authority => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const openExternal = vi.fn();
    const updateService = { getChangelog: vi.fn(() => []), checkForUpdates: vi.fn(), openReleasePage: vi.fn() };
    registerIpcHandlers({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) },
      app: { getVersion: () => '2.0.0' }, shell: { openExternal }, updateAuthority: authority, updateService,
      registerCoreHandlers: vi.fn() } as unknown as Parameters<typeof registerIpcHandlers>[0]);
    for (const key of ['updates:check', 'app:checkForUpdates', 'update:check']) {
      expect(await handlers.get(key)?.({}, { includePrerelease: true, updateAuthority: 'github-manual' })).toMatchObject({
        updateAvailable: false, error: { code: 'UPDATE_MANAGED_EXTERNALLY' },
      });
    }
    for (const key of ['updates:openReleasePage', 'app:openReleasesPage', 'update:openReleases']) {
      expect(await handlers.get(key)?.({})).toMatchObject({ success: false, error: { code: 'UPDATE_MANAGED_EXTERNALLY' } });
    }
    expect(fetchMock).not.toHaveBeenCalled(); expect(openExternal).not.toHaveBeenCalled();
    expect(updateService.checkForUpdates).not.toHaveBeenCalled(); expect(updateService.openReleasePage).not.toHaveBeenCalled();
    expect(await handlers.get('updates:getChangelog')?.({})).toEqual({ entries: [], currentVersion: '2.0.0' });
  });
});
