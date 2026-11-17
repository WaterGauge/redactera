import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerCoreHandlers, registerIpcHandlers, updateConstants } from './ipcHandlers';
import { type WriteTarget, createPathValidator } from './pathValidator';
import { DEFAULT_SETTINGS, type AppSettings } from '../types/settings';

type IpcHandler = (...args: any[]) => any;

function createValidSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}

function createHarness() {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  };

  const settingsState = createValidSettings();
  const settingsManager = {
    getSettingsPath: vi.fn(() => '/tmp/userData/settings.json'),
    readSettings: vi.fn(() => settingsState),
    readPreferences: vi.fn(() => settingsState),
    writeSettings: vi.fn(),
    writePreferences: vi.fn(),
    validateBaiduKeys: vi.fn().mockResolvedValue(true),
  };

  const exportFileImpl = vi.fn<(source: string, target: WriteTarget) => Promise<void>>();
  const sender = { mainFrame: {} };
  const dependencies = {
    ipcMain,
    app: {
      getPath: vi.fn((name: string): string => (name === 'temp' ? '/tmp' : '/other')),
    },
    dialog: {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: true, filePath: undefined }),
    },
    mainWindowProvider: vi.fn(() => ({ isDestroyed: vi.fn(() => false), webContents: sender })),
    pathValidator: {
      addAllowedPath: vi.fn(),
      setWriteTarget: vi.fn(),
      clearWriteTarget: vi.fn(),
      claimWriteTarget: vi.fn((file: string | null): WriteTarget | null => file ? ({filePath: file, realParent: path.dirname(file)}) : null),
      resolveUserPath: vi.fn((value: string) => value),
      isResolvedPathAllowed: vi.fn(() => true),
      isWritablePathAllowed: vi.fn(() => true),
      getDraggedFilesDirectory: vi.fn((tempRoot: string) => `${tempRoot}/dragged`),
      sanitizeDraggedFileName: vi.fn((name: string) => name),
      isPathInsideDirectory: vi.fn(() => true),
    },
    settingsManager,
    pythonProcessManager: {
      start: vi.fn(),
      stop: vi.fn(),
      send: vi.fn().mockResolvedValue({ output_path: '/tmp/out.pdf' }),
    },
    logger: {
      log: vi.fn(),
      initialize: vi.fn(),
    },
    exportFileImpl,
    revealFile: vi.fn(),
    fsImpl: {
      readFileSync: vi.fn(() => 'base64-content'),
      existsSync: vi.fn(() => true),
      promises: {
        realpath: vi.fn(async (file: string) => file),
        lstat: vi.fn(async () => ({ isFile: (): boolean => true })),
        copyFile: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    },
  };

  exportFileImpl.mockImplementation((source, target) => dependencies.fsImpl.promises.copyFile(source, target.filePath));
  registerCoreHandlers(dependencies as any);
  return { handlers, dependencies, settingsState, sender };
}

describe('registerCoreHandlers', () => {
  it('opens files, validates main window, and tracks allowed paths', async () => {
    const { handlers, dependencies } = createHarness();
    dependencies.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/a.pdf'],
    });

    const result = await handlers.get('dialog:openFile')?.({}, { title: 'Pick PDF' });

    expect(result).toEqual(['/tmp/a.pdf']);
    expect(dependencies.pathValidator.addAllowedPath).toHaveBeenCalledWith('/tmp/a.pdf');
    expect(dependencies.dialog.showOpenDialog.mock.calls[0][1].properties).toEqual(['openFile']);
    dependencies.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/a.pdf', '/tmp/b.pdf'] });
    dependencies.pathValidator.addAllowedPath.mockClear();
    await expect(handlers.get('dialog:openFile')?.({})).rejects.toThrow('请一次选择一个 PDF 文件');
    expect(dependencies.pathValidator.addAllowedPath).not.toHaveBeenCalled();
    expect(dependencies.dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'Pick PDF' })
    );

    dependencies.mainWindowProvider.mockReturnValueOnce(null as any);
    await expect(handlers.get('dialog:openFile')?.({}, {})).rejects.toThrow(
      'Main window not available'
    );
  });

  it('handles save dialog path registration and cancellation', async () => {
    const { handlers, dependencies } = createHarness();
    dependencies.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/tmp/export/output.pdf',
    });

    await expect(handlers.get('dialog:saveFile')?.({}, {})).resolves.toBe('/tmp/export/output.pdf');
    expect(dependencies.pathValidator.setWriteTarget).toHaveBeenCalledWith({
      filePath: '/tmp/export/output.pdf', realParent: path.dirname('/tmp/export/output.pdf'),
    });

    dependencies.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: true,
      filePath: undefined,
    });
    await expect(handlers.get('dialog:saveFile')?.({}, {})).resolves.toBeNull();
  });

  it('processes pdf actions and enforces read-file allowlist', async () => {
    const { handlers, dependencies } = createHarness();
    dependencies.pythonProcessManager.send.mockResolvedValueOnce({ output_path: '/tmp/report.pdf' });

    const processResult = await handlers.get('pdf:process')?.({}, { action: 'desensitize', payload: { file_path: '/tmp/allowed.pdf', keywords: ['TARGET'] } });
    expect(processResult).toEqual({ output_path: '/tmp/report.pdf' });
    expect(dependencies.pythonProcessManager.send).toHaveBeenCalledWith('desensitize', { file_path: '/tmp/allowed.pdf', keywords: ['TARGET'], settings: {} });
    expect(dependencies.pathValidator.addAllowedPath).toHaveBeenCalledWith('/tmp/report.pdf');

    dependencies.pathValidator.resolveUserPath.mockReturnValueOnce('/tmp/allowed.pdf');
    dependencies.pathValidator.isResolvedPathAllowed.mockReturnValueOnce(true);
    expect(handlers.get('pdf:readFile')?.({}, '/tmp/allowed.pdf')).toBe('base64-content');

    dependencies.pathValidator.resolveUserPath.mockReturnValueOnce('/tmp/blocked.pdf');
    dependencies.pathValidator.isResolvedPathAllowed.mockReturnValueOnce(false);
    expect(() => handlers.get('pdf:readFile')?.({}, '/tmp/blocked.pdf')).toThrow(
      'Access denied: file not in allowed paths'
    );
  });

  it('reads/saves settings and toggles developer mode', async () => {
    const { handlers, dependencies, settingsState } = createHarness();

    expect(handlers.get('settings:get')?.({})).toEqual(settingsState);

    expect(handlers.get('settings:get')?.({}, false)).toEqual(settingsState);
    expect(dependencies.settingsManager.readPreferences).toHaveBeenCalledOnce();

    const newSettings = createValidSettings({ developer_mode: true });
    expect(handlers.get('settings:save')?.({}, newSettings)).toEqual({
      success: true,
    });
    expect(dependencies.settingsManager.writeSettings).toHaveBeenCalledWith(newSettings);
    handlers.get('settings:save')?.({}, newSettings, false);
    expect(dependencies.settingsManager.writePreferences).toHaveBeenCalledWith(newSettings);

    dependencies.settingsManager.validateBaiduKeys.mockResolvedValueOnce(false);
    await expect(
      handlers.get('settings:validateBaidu')?.({}, { apiKey: 'a', secretKey: 'b' })
    ).resolves.toEqual({ valid: false });

    expect(handlers.get('get-developer-mode')?.({})).toEqual({
      enabled: false,
      logFolderPath: '',
    });

    expect(handlers.get('set-developer-mode')?.({}, true)).toEqual({
      success: true,
    });
    expect(dependencies.settingsManager.writePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ developer_mode: true })
    );
    expect(dependencies.logger.initialize).toHaveBeenCalledWith('', true);
  });

  it('selects a log folder without persisting or switching the logger', async () => {
    const { handlers, dependencies } = createHarness();
    dependencies.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    await expect(handlers.get('select-log-folder')?.({})).resolves.toEqual({ success: false });

    dependencies.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/logs'],
    });
    await expect(handlers.get('select-log-folder')?.({})).resolves.toEqual({
      success: true,
      path: '/tmp/logs',
    });
    expect(dependencies.settingsManager.writeSettings).not.toHaveBeenCalled();
    expect(dependencies.logger.initialize).not.toHaveBeenCalled();
  });

  it('copies files only when source and destination are allowlisted', async () => {
    const { handlers, dependencies } = createHarness();

    dependencies.pathValidator.resolveUserPath
      .mockReturnValueOnce('/tmp/source.pdf')
      .mockReturnValueOnce('/tmp/dest.pdf');
    dependencies.pathValidator.isResolvedPathAllowed.mockReturnValueOnce(true);
    await expect(
      handlers.get('file:copy')?.({}, '/tmp/source.pdf', '/tmp/dest.pdf')
    ).resolves.toEqual({ success: true });

    expect(dependencies.fsImpl.promises.copyFile).toHaveBeenCalledWith(
      '/tmp/source.pdf',
      '/tmp/dest.pdf'
    );
    expect(dependencies.pathValidator.addAllowedPath).toHaveBeenCalledWith('/tmp/dest.pdf');

    dependencies.pathValidator.resolveUserPath
      .mockReturnValueOnce('/tmp/blocked-source.pdf')
      .mockReturnValueOnce('/tmp/dest.pdf');
    dependencies.pathValidator.isResolvedPathAllowed.mockReturnValueOnce(false);
    await expect(
      handlers.get('file:copy')?.({}, '/tmp/blocked-source.pdf', '/tmp/dest.pdf')
    ).rejects.toThrow('Access denied: source file is not allowlisted');

    dependencies.pathValidator.resolveUserPath
      .mockReturnValueOnce('/tmp/source.pdf')
      .mockReturnValueOnce('/tmp/blocked-dest.pdf');
    dependencies.pathValidator.isResolvedPathAllowed.mockReturnValueOnce(true);
    dependencies.pathValidator.claimWriteTarget.mockReturnValueOnce(null);
    await expect(
      handlers.get('file:copy')?.({}, '/tmp/source.pdf', '/tmp/blocked-dest.pdf')
    ).rejects.toThrow('Access denied: destination was not selected for this export');
  });


  it('keeps the copy request pending beyond the Python deadline until the disk operation settles', async () => {
    const { handlers, dependencies } = createHarness();
    const copy = handlers.get('file:copy');
    if (!copy) throw new Error('Copy handler was not registered');
    let finishCopy!: () => void;
    dependencies.fsImpl.promises.copyFile.mockReturnValueOnce(new Promise<void>(resolve => { finishCopy = resolve; }));
    vi.useFakeTimers();
    try {
      let settled = false;
      const copying = copy({}, '/tmp/source.pdf', '/tmp/dest.pdf');
      copying.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(300001);
      expect(settled).toBe(false);
      expect(dependencies.pythonProcessManager.send).not.toHaveBeenCalled();
      finishCopy();
      await expect(copying).resolves.toEqual({ success: true });
    } finally { vi.useRealTimers(); }
  });

  it('exports byte-identical data through the real returned-path and save-dialog grants', async () => {
    const { handlers, dependencies } = createHarness();
    Object.assign(dependencies.pathValidator, createPathValidator());
    dependencies.fsImpl.promises.copyFile.mockImplementation((source: string, target: string) => fs.promises.copyFile(source, target));
    const directory = fs.mkdtempSync(path.join(process.env.CR004_TEST_TMPDIR ?? os.tmpdir(), 'cr004-copy-'));
    try {
      const processed = path.join(directory, 'processed.pdf');
      const exported = path.join(directory, 'exported.pdf');
      const bytes = Buffer.from('%PDF-1.7\nSynthetic byte-copy fixture\n%%EOF\n');
      fs.writeFileSync(processed, bytes);
      const selected = path.join(directory, 'selected.pdf');
      fs.writeFileSync(selected, bytes);
      dependencies.pathValidator.addAllowedPath(selected);
      dependencies.app.getPath.mockReturnValue(directory);
      dependencies.pythonProcessManager.send.mockResolvedValueOnce({ output_path: processed });
      const processPDF = handlers.get('pdf:process'), save = handlers.get('dialog:saveFile'), copy = handlers.get('file:copy');
      if (!processPDF || !save || !copy) throw new Error('Export handlers were not registered');
      await processPDF({}, { action: 'desensitize', payload: { file_path: selected, keywords: ['TARGET'] } });
      dependencies.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: exported });
      expect(await save({}, {})).toBe(exported);
      await expect(copy({}, processed, exported)).resolves.toEqual({ success: true });
      expect(fs.readFileSync(exported)).toEqual(bytes);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('registerIpcHandlers default update service', () => {
  it('uses fetch-based release lookup, filters changelog, and chooses the newest semver match', async () => {
    const handlers = new Map<string, IpcHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        { tag_name: 'v1.2.1-beta.1', prerelease: true, draft: false, body: 'beta 1', html_url: 'https://example.com/b1' },
        { tag_name: 'v1.2.1-beta.2', prerelease: true, draft: false, body: 'beta 2', html_url: 'https://example.com/b2' },
        { tag_name: 'v1.2.1', prerelease: false, draft: false, body: 'stable', html_url: 'https://example.com/stable' },
        { tag_name: 'v1.3.0', prerelease: false, draft: true, body: 'draft', html_url: 'https://example.com/draft' },
      ]),
    });
    vi.stubGlobal('fetch', fetchMock);

    registerIpcHandlers({
      updateAuthority: 'github-manual',
      ipcMain: ipcMain as any,
      app: { getVersion: vi.fn(() => '1.2.0'), getPath: vi.fn() } as any,
      shell: { openExternal: vi.fn().mockResolvedValue(undefined) } as any,
      registerCoreHandlers: vi.fn(),
    } as any);

    const changelog = await handlers.get('updates:getChangelog')?.({});
    expect(changelog.currentVersion).toBe('1.2.0');
    expect(changelog.entries.at(-1)?.version).toBe('v1.2.0');

    const stableResult = await handlers.get('updates:check')?.({}, { includePrerelease: false });
    expect(stableResult).toMatchObject({
      updateAvailable: true,
      latestVersion: '1.2.1',
      releaseNotes: 'stable',
    });

    const prereleaseResult = await handlers.get('updates:check')?.({}, { includePrerelease: true });
    expect(prereleaseResult).toMatchObject({
      updateAvailable: true,
      latestVersion: '1.2.1',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      updateConstants.GITHUB_RELEASES_API_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'PDF-Desensitization' }),
      })
    );
  });


  it.each([
    {
      name: 'stable-only ignores invalid and mislabeled prerelease tags',
      installed: '2.0.0+local',
      tags: ['v2.0.0+other', 'v2.1.0-rc.1', 'v2.1.0-rc.01', 'v02.1.0', 'v2.1.0-beta..1', 'v2.0.1'],
      includePrerelease: false,
      latest: '2.0.1',
      prerelease: false,
    },
    {
      name: 'beta identifiers compare numerically',
      installed: '2.0.0-alpha.9',
      tags: ['v2.0.0-beta.2', 'v2.0.0-beta.10', 'v2.0.0-alpha.11'],
      includePrerelease: true,
      latest: '2.0.0-beta.10',
      prerelease: true,
    },
    {
      name: 'RC sorts above beta and alpha',
      installed: '2.0.0-beta.9',
      tags: ['v2.0.0-beta.10', 'v2.0.0-rc.1', 'v2.0.0-alpha.20'],
      includePrerelease: true,
      latest: '2.0.0-rc.1',
      prerelease: true,
    },
    {
      name: 'the stable release sorts above its candidates',
      installed: '2.0.0-rc.1',
      tags: ['v2.0.0-rc.2', 'v2.0.0'],
      includePrerelease: true,
      latest: '2.0.0',
      prerelease: false,
    },
    {
      name: 'build metadata does not create an update',
      installed: '2.0.0+local',
      tags: ['v2.0.0+remote'],
      includePrerelease: true,
      latest: '2.0.0+local',
    },
  ])('$name', async ({ installed, tags, includePrerelease, latest, prerelease }) => {
    const handlers = new Map<string, IpcHandler>();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => tags.map(tag_name => ({ tag_name, draft: false, prerelease: false })),
    }));
    registerIpcHandlers({
      updateAuthority: 'github-manual',
      ipcMain: { handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) } as any,
      app: { getVersion: () => installed } as any,
      shell: { openExternal: vi.fn() } as any,
      registerCoreHandlers: vi.fn(),
    } as any);
    const result = await handlers.get('updates:check')?.({}, { includePrerelease });
    expect(result).toMatchObject({
      currentVersion: installed, latestVersion: latest, updateAvailable: latest !== installed,
      ...(prerelease === undefined ? {} : { prerelease }),
    });
  });

  it('returns structured errors when fetch fails or opening releases throws', async () => {
    const handlers = new Map<string, IpcHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    registerIpcHandlers({
      updateAuthority: 'github-manual',
      ipcMain: ipcMain as any,
      app: { getVersion: vi.fn(() => '1.2.0'), getPath: vi.fn() } as any,
      shell: { openExternal: vi.fn().mockRejectedValue(new Error('browser blocked')) } as any,
      registerCoreHandlers: vi.fn(),
    } as any);

    const updateResult = await handlers.get('app:checkForUpdates')?.({}, { includePrerelease: false });
    expect(updateResult).toEqual({
      updateAvailable: false,
      currentVersion: '1.2.0',
      latestVersion: '1.2.0',
      error: {
        code: 'UPDATE_CHECK_FAILED',
        message: 'GitHub Releases API returned 503',
      },
    });

    const openResult = await handlers.get('app:openReleasesPage')?.({});
    expect(openResult).toEqual({
      success: false,
      error: {
        code: 'OPEN_RELEASE_PAGE_FAILED',
        message: 'browser blocked',
      },
    });
  });
});

it('reveals only a completed export owned by the current workbench main frame', async () => {
  const { handlers, dependencies, sender } = createHarness();
  const event = { sender, senderFrame: sender.mainFrame };
  const reveal = handlers.get('file:revealExport') as IpcHandler;
  await expect(reveal(event)).rejects.toThrow('Access denied');
  await handlers.get('file:copy')?.(event, '/tmp/source.pdf', '/exports/result.pdf');
  await expect(reveal(event, '/other/file.pdf')).rejects.toThrow('Access denied');
  await expect(reveal({ sender, senderFrame: {} })).rejects.toThrow('Access denied');
  await expect(reveal({ sender: { ...sender }, senderFrame: sender.mainFrame })).rejects.toThrow('Access denied');
  expect(dependencies.revealFile).not.toHaveBeenCalled();
  await expect(reveal(event)).resolves.toEqual({ success: true });
  expect(dependencies.revealFile).toHaveBeenCalledWith(path.normalize('/exports/result.pdf'));
  dependencies.fsImpl.promises.lstat.mockResolvedValueOnce({ isFile: () => false });
  await expect(reveal(event)).rejects.toThrow('no longer available');
});
it('does not grant reveal access before publication or after a failed copy', async () => {
  const { handlers, dependencies, sender } = createHarness();
  const event = { sender, senderFrame: sender.mainFrame };
  let finish!: () => void;
  dependencies.exportFileImpl.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const copy = handlers.get('file:copy')?.(event, '/tmp/source.pdf', '/exports/result.pdf');
  await expect(handlers.get('file:revealExport')?.(event)).rejects.toThrow('Access denied');
  finish(); await copy;
  dependencies.exportFileImpl.mockRejectedValueOnce(new Error('disk full'));
  await expect(handlers.get('file:copy')?.(event, '/tmp/source.pdf', '/exports/failed.pdf')).rejects.toThrow('disk full');
  await handlers.get('file:revealExport')?.(event);
  expect(dependencies.revealFile).toHaveBeenLastCalledWith(path.normalize('/exports/result.pdf'));
});
