import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsModal } from '../components/SettingsModal';
import { registerCoreHandlers } from '../main/ipcHandlers';
import { createPathValidator } from '../main/pathValidator';
import { DEFAULT_SETTINGS } from '../types/settings';

afterEach(() => cleanup());
type Handler = (...args: unknown[]) => unknown;
async function mount() {
  let persisted = { ...DEFAULT_SETTINGS, developer_mode: true, log_folder_path: '/logs/old' };
  const handlers = new Map<string, Handler>();
  const writeSettings = vi.fn((settings: typeof persisted) => { persisted = { ...settings }; });
  const logger = { log: vi.fn(), initialize: vi.fn() };
  const picker = vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/logs/new'] });
  registerCoreHandlers({
    ipcMain: { handle: (key: string, handler: Handler) => { handlers.set(key, handler); } },
    app: { getPath: () => '/temp' }, dialog: { showOpenDialog: picker },
    pathValidator: createPathValidator(), settingsManager: { readSettings: () => ({ ...persisted }), readPreferences: () => ({ ...persisted }),
      writeSettings, writePreferences: writeSettings },
    logger,
  } as unknown as Parameters<typeof registerCoreHandlers>[0]);
  const invoke = (name: string, ...args: unknown[]) => handlers.get(name)?.({}, ...args);
  const api = { getSettings: async (includeCredentials?: boolean) => invoke('settings:get', includeCredentials),
    getDeveloperMode: async () => invoke('get-developer-mode'),
    getAppVersion: async () => '1.2.0', getChangelog: async () => ({ entries: [] }),
    selectLogFolder: vi.fn(async () => invoke('select-log-folder')),
    saveSettings: vi.fn(async (settings, includeCredentials?: boolean) => invoke('settings:save', settings, includeCredentials)),
    setDeveloperMode: vi.fn(async enabled => invoke('set-developer-mode', enabled)),
  };
  Object.defineProperty(window, 'electronAPI', { configurable: true, writable: true, value: api });
  const onClose = vi.fn();
  await act(async () => { render(<SettingsModal onClose={onClose} />); });
  const choose = async () => { await act(async () => { fireEvent.click(screen.getByText('选择文件夹')); }); };
  const save = async () => { await act(async () => { fireEvent.click(screen.getByText('保存')); }); };
  return { get persisted() { return persisted; }, writeSettings, logger, picker, api, onClose, choose, save };
}
it('keeps folder selection in the draft and applies the selected path on save', async () => {
  const h = await mount(); await h.choose();
  expect(screen.getByPlaceholderText('未选择文件夹')).toHaveValue('/logs/new');
  expect(h.persisted.log_folder_path).toBe('/logs/old'); expect(h.writeSettings).not.toHaveBeenCalled();
  await h.save(); expect(h.persisted.log_folder_path).toBe('/logs/new');
  expect(h.logger.initialize).toHaveBeenCalledWith('/logs/new', true); expect(h.onClose).toHaveBeenCalledOnce();
});
it('cancels folder changes without changing live settings or logger', async () => {
  const h = await mount(); await h.choose(); fireEvent.click(screen.getByText('取消'));
  expect(h.persisted.log_folder_path).toBe('/logs/old');
  expect(h.writeSettings).not.toHaveBeenCalled(); expect(h.logger.initialize).not.toHaveBeenCalled();
});
it('cancels a developer mode toggle without applying it', async () => {
  const h = await mount(); await act(async () => { fireEvent.click(screen.getByLabelText('开发者模式')); });
  fireEvent.click(screen.getByText('取消'));
  expect(h.persisted.developer_mode).toBe(true); expect(h.api.setDeveloperMode).not.toHaveBeenCalled();
});
it('keeps the old draft on picker cancellation', async () => {
  const h = await mount(); h.picker.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  await h.choose(); expect(screen.getByPlaceholderText('未选择文件夹')).toHaveValue('/logs/old');
  expect(h.writeSettings).not.toHaveBeenCalled();
});
it('does not initialize logging or close after persistence fails', async () => {
  const h = await mount(); await h.choose(); h.writeSettings.mockImplementationOnce(() => { throw new Error('disk failed'); });
  await h.save(); expect(screen.getByText('设置保存失败，请重试。')).toBeInTheDocument();
  expect(h.logger.initialize).not.toHaveBeenCalled(); expect(h.onClose).not.toHaveBeenCalled();
});
it('blocks saving while a folder selection is still pending', async () => {
  const h = await mount(); let finish!: (value: unknown) => void;
  h.picker.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async () => { fireEvent.click(screen.getByText('选择文件夹')); });
  await h.save(); expect(h.writeSettings).not.toHaveBeenCalled();
  await act(async () => { finish({ canceled: false, filePaths: ['/logs/new'] }); });
  await h.save(); expect(h.persisted.log_folder_path).toBe('/logs/new');
});
