import React from 'react';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsModal } from '../components/SettingsModal';
import { createSettingsManager } from '../main/settingsManager';
import { registerCoreHandlers } from '../main/ipcHandlers';
import { createPathValidator } from '../main/pathValidator';
import { DEFAULT_SETTINGS, type AppSettings } from '../types/settings';

const SECRET = 'SYNTHETIC_RECOVERY_CREDENTIAL';
const roots: string[] = [];
afterEach(() => { cleanup(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

function harness(initial?: unknown, available = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr023-settings-'));
  roots.push(root);
  const file = path.join(root, 'settings.json');
  if (initial !== undefined) fs.writeFileSync(file, JSON.stringify(initial));
  const state = { available, decryptError: false };
  const manager = createSettingsManager({ app: { getPath: () => root }, platform: 'darwin', safeStorage: {
    isEncryptionAvailable: () => state.available,
    encryptString: plain => Buffer.from(`enc:${plain}`),
    decryptString: encrypted => { if (state.decryptError) throw new Error(SECRET); return encrypted.toString().slice(4); },
  } });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const logger = { log: vi.fn(), initialize: vi.fn() };
  registerCoreHandlers({ ipcMain: { handle: (key: string, handler: (...args: unknown[]) => unknown) => { handlers.set(key, handler); } },
    app: { getPath: () => root, getVersion: () => '1.2.1-beta.3' }, dialog: {},
    pathValidator: createPathValidator(), settingsManager: manager, logger,
  } as unknown as Parameters<typeof registerCoreHandlers>[0]);
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  const api = { getSettings: vi.fn(async (includeCredentials?: boolean) => call('settings:get', includeCredentials) as AppSettings),
    saveSettings: vi.fn(async (value: AppSettings, includeCredentials?: boolean) => call('settings:save', value, includeCredentials)),
    getAppVersion: async () => '1.2.1-beta.3', getChangelog: async () => ({ entries: [] }) };
  Object.defineProperty(window, 'electronAPI', { configurable: true, writable: true, value: api });
  const onClose = vi.fn();
  const mount = async () => { await act(async () => { render(<SettingsModal onClose={onClose} />); }); };
  const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };
  const stored = () => fs.readFileSync(file, 'utf8');
  return { root, file, state, manager, api, logger, call, onClose, mount, click, stored };
}

function diskCredentials() {
  return { ...DEFAULT_SETTINGS, ocr_mode: 'paddle', export_dpi: 300,
    paddle_token: Buffer.from(`enc:${SECRET}`).toString('base64'), _encrypted: true };
}

function credentialInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="password"]');
  if (!input) throw new Error('Expected a credential input');
  return input;
}

it('blocks the default draft while the initial read is pending', async () => {
  const h = harness();
  let resolve!: (settings: AppSettings) => void;
  h.api.getSettings.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
  await h.mount();
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  await h.click('保存'); expect(h.api.saveSettings).not.toHaveBeenCalled();
  await act(async () => { resolve(h.manager.readSettings()); });
  expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
});

it('does not overwrite settings when the initial IPC read rejects, and can retry', async () => {
  const h = harness(); h.api.getSettings.mockRejectedValueOnce(new Error(SECRET));
  await h.mount();
  expect(screen.getByRole('alert')).toHaveTextContent('无法读取设置');
  expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  await h.click('保存'); expect(h.api.saveSettings).not.toHaveBeenCalled();
  await h.click('重试读取'); await h.click('保存');
  expect(h.onClose).toHaveBeenCalledOnce();
});

it('keeps the dialog and logger unchanged after unavailable encryption, then retries safely', async () => {
  const h = harness(undefined, false); await h.mount();
  await act(async () => { fireEvent.click(screen.getByText('PaddleOCR 服务')); });
  const token = credentialInput();
  await act(async () => { fireEvent.change(token, { target: { value: SECRET } });
    fireEvent.change(screen.getByRole('slider'), { target: { value: '3' } }); });
  await h.click('保存');
  expect(screen.getByRole('alert')).toHaveTextContent('系统安全存储不可用');
  expect(fs.existsSync(h.file)).toBe(false);
  expect(h.logger.initialize).not.toHaveBeenCalled(); expect(h.onClose).not.toHaveBeenCalled();
  h.state.available = true; await h.click('重试读取');
  expect(document.querySelector('input[type="password"]')).toHaveValue(SECRET);
  await act(async () => { fireEvent.change(credentialInput(), { target: { value: SECRET } }); });
  await h.click('保存');
  expect(h.stored()).not.toContain(SECRET);
  expect(JSON.parse(h.stored()).redaction_scope).toBe('paragraph');
  expect(h.logger.initialize).toHaveBeenCalledOnce(); expect(h.onClose).toHaveBeenCalledOnce();
  expect(fs.readdirSync(h.root)).toEqual(['settings.json']);
});

it('saves ordinary settings with locked credentials and retains the stored ciphertext', async () => {
  const h = harness(diskCredentials(), false); await h.mount();
  expect(h.api.getSettings).toHaveBeenCalledWith(false);
  expect(credentialInput()).toBeDisabled();
  expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  const before = JSON.parse(h.stored()).paddle_token;
  await h.click('编辑已保存的凭据');
  expect(screen.getByText(/已保存的凭证未载入/)).toBeInTheDocument();
  await act(async () => { fireEvent.change(screen.getByRole('slider'), { target: { value: '3' } }); });
  await h.click('保存');
  expect(h.api.saveSettings).toHaveBeenCalledWith(expect.anything(), false);
  expect(JSON.parse(h.stored())).toMatchObject({ paddle_token: before, _encrypted: true, redaction_scope: 'paragraph' });
});

it('loads saved credentials only on an explicit edit and supports retry after unlocking', async () => {
  const h = harness(diskCredentials(), false); await h.mount();
  await h.click('编辑已保存的凭据');
  expect(credentialInput()).toBeDisabled();
  h.state.available = true; h.call('get-developer-mode');
  expect(credentialInput()).toHaveValue('');
  await h.click('重试读取');
  expect(credentialInput()).toHaveValue(SECRET);
  await act(async () => { fireEvent.change(credentialInput(), { target: { value: SECRET + '_EDITED' } }); });
  await h.click('保存');
  expect(h.api.saveSettings).toHaveBeenCalledWith(expect.anything(), true);
  expect(h.manager.readSettings().paddle_token).toBe(SECRET + '_EDITED');
  expect(h.stored()).not.toContain(SECRET);
});

it('keeps a decryption failure recoverable without resetting preferences or the file', async () => {
  const h = harness(diskCredentials()); h.state.decryptError = true; const before = h.stored(); await h.mount();
  await h.click('编辑已保存的凭据');
  expect(screen.getByText(/无法解密已保存的凭证/)).toBeInTheDocument();
  expect(Array.from(document.querySelectorAll('select')).some(select => select.value === '300')).toBe(true);
  expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  expect(h.stored()).toBe(before);
  h.state.decryptError = false; await h.click('重试读取'); await h.click('保存');
  expect(h.manager.readSettings().paddle_token).toBe(SECRET);
});

it('explicitly migrates a legacy plaintext record on successful user save', async () => {
  const h = harness({ ...DEFAULT_SETTINGS, paddle_token: SECRET, export_dpi: 300 }); const before = h.stored();
  await h.mount();
  await act(async () => { fireEvent.click(screen.getByText('PaddleOCR 服务')); });
  await h.click('编辑已保存的凭据');
  expect(screen.getByText(/旧版明文凭证/)).toBeInTheDocument(); expect(h.stored()).toBe(before);
  await h.click('保存'); expect(h.stored()).not.toContain(SECRET);
  expect(h.manager.readSettings()).toMatchObject({ paddle_token: SECRET, export_dpi: 300, credential_storage_status: 'available' });
});

it.each([undefined, true, { success: false }])('does not close for an unconfirmed save result (%j)', async result => {
  const h = harness(); await h.mount(); h.api.saveSettings.mockResolvedValueOnce(result);
  await h.click('保存'); expect(h.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('设置保存失败');
});

it('shows the actionable error without Electron transport details', async () => {
  const h = harness(); await h.mount();
  h.api.saveSettings.mockRejectedValueOnce(new Error("Error invoking remote method 'settings:save': Error: 系统安全存储不可用"));
  await h.click('保存');
  expect(screen.getByRole('alert')).toHaveTextContent('系统安全存储不可用');
  expect(screen.getByRole('alert')).not.toHaveTextContent('settings:save');
});
