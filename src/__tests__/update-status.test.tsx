import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsModal } from '../components/SettingsModal';
import { registerIpcHandlers } from '../main/ipcHandlers';
import { DEFAULT_SETTINGS } from '../types/settings';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
type Handler = (...args: unknown[]) => unknown;
async function mount(response?: unknown, raw = false) {
  const handlers = new Map<string, Handler>();
  const fetcher = vi.fn<typeof fetch>();
  if (response instanceof Error) fetcher.mockRejectedValue(response);
  else fetcher.mockResolvedValue(response as Response);
  vi.stubGlobal('fetch', fetcher);
  const openExternal = vi.fn().mockResolvedValue(undefined);
  registerIpcHandlers({
    ipcMain: { handle: (name: string, fn: Handler) => { handlers.set(name, fn); } },
    app: { getVersion: () => '2.0.0' }, shell: { openExternal },
    registerCoreHandlers: vi.fn(),
  } as unknown as Parameters<typeof registerIpcHandlers>[0]);
  const api = {
    getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
    getDeveloperMode: vi.fn().mockResolvedValue({ enabled: false, logFolderPath: '' }),
    getAppVersion: vi.fn().mockResolvedValue('2.0.0'),
    getChangelog: vi.fn().mockResolvedValue({ currentVersion: '2.0.0', entries: [] }),
    checkForUpdates: vi.fn(async options => raw ? response : handlers.get('app:checkForUpdates')?.({}, options)),
    openReleasePage: vi.fn(async () => handlers.get('app:openReleasesPage')?.({})),
  };
  Object.defineProperty(window, 'electronAPI', { configurable: true, writable: true, value: api });
  await act(async () => { render(<SettingsModal onClose={vi.fn()} />); });
  const check = async () => { await act(async () => { fireEvent.click(screen.getByText('检查更新')); }); };
  return { api, fetcher, openExternal, check };
}
const http = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body });
const assertFailure = () => {
  expect(screen.getByText('检查更新失败，请检查网络后重试')).toBeInTheDocument();
  expect(screen.queryByText(/已是最新版本/)).not.toBeInTheDocument();
  expect(screen.queryByText(/发现新版本/)).not.toBeInTheDocument();
  expect(screen.getByText('检查更新')).toBeEnabled();
};

it.each([404, 429, 503])('shows HTTP %s as failure through real Main handlers', async status => {
  const h = await mount(http(null, status)); await h.check(); assertFailure();
});
it.each([new Error('offline'), Object.assign(new Error('aborted'), { name: 'AbortError' })])(
  'shows network/abort as failure', async error => { const h = await mount(error); await h.check(); assertFailure(); });
it.each([null, {}, [null], [{}]].map(value => [value]))('rejects malformed API JSON %j', async value => {
  const h = await mount(http(value)); await h.check(); assertFailure();
});
it.each([null, [], {}, 'invalid', { updateAvailable: 'false' }, { updateAvailable: true },
  { updateAvailable: true, latestVersion: 42 }, { success: false }].map(value => [value]))(
  'rejects malformed/failed bridge data %j', async value => {
    const h = await mount(value, true); await h.check(); assertFailure();
  });
it('checks the Redactera repository and opens the same Releases page', async () => {
  const h = await mount(http([{ tag_name: 'v2.0.0', draft: false, prerelease: false }]));
  await h.check();
  expect(h.fetcher).toHaveBeenCalledWith('https://api.github.com/repos/WaterGauge/redactera/releases', expect.anything());
  expect(screen.getByText('已是最新版本（v2.0.0）')).toBeInTheDocument();

  const releasesUrl = 'https://github.com/WaterGauge/redactera/releases';
  expect(screen.getByText(`下载页面：${releasesUrl}`)).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByText('打开下载页面')); });
  expect(h.openExternal).toHaveBeenCalledWith(releasesUrl);
});
it('keeps a valid available release and notes working', async () => {
  const h = await mount(http([{ tag_name: 'v2.0.1', body: 'PUBLIC NOTES', draft: false, prerelease: false }]));
  await h.check(); expect(screen.getAllByText('发现新版本：v2.0.1').length).toBeGreaterThan(0);
  expect(screen.getByText('PUBLIC NOTES')).toBeInTheDocument();
});
it('clears failure on a successful retry', async () => {
  const h = await mount(http(null, 404)); await h.check(); assertFailure();
  h.fetcher.mockResolvedValue(http([]) as Response); await h.check();
  expect(screen.queryByText(/检查更新失败/)).not.toBeInTheDocument();
  expect(screen.getByText('已是最新版本（v2.0.0）')).toBeInTheDocument();
});
it('honors the actual timeout abort signal and re-enables checking', async () => {
  const h = await mount(http([]));
  h.fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    void _url; void _resolve;
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })));
  }));
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByText('检查更新')); await vi.advanceTimersByTimeAsync(10000); });
  assertFailure();
});
it('shows a failed manual-open result from Main', async () => {
  const h = await mount(http([])); h.openExternal.mockRejectedValueOnce(new Error('blocked'));
  await act(async () => { fireEvent.click(screen.getByText('打开下载页面')); });
  expect(screen.getByText('无法打开下载页面，请手动访问下方链接')).toBeInTheDocument();
});
