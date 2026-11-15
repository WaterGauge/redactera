import { beforeEach, describe, expect, it, vi } from 'vitest';
import { changelogEntries } from '../../data/changelog';
import { registerIpcHandlers } from '../../main/ipcHandlers';

type IpcHandler = (...args: unknown[]) => unknown;

describe('IPC Integration', () => {
  let mockHandlers: Map<string, IpcHandler>;
  let mockIpcMain: { handle: ReturnType<typeof vi.fn> };
  let mockDependencies: any;

  beforeEach(() => {
    mockHandlers = new Map();

    mockIpcMain = {
      handle: vi.fn((channel: string, handler: IpcHandler) => {
        mockHandlers.set(channel, handler);
      }),
    };

    mockDependencies = {
      app: {
        getVersion: vi.fn(() => '2.0.0'),
      },
      shell: {
        openExternal: vi.fn().mockResolvedValue(undefined),
      },
      updateService: {
        getChangelog: vi.fn(() => changelogEntries),
        checkForUpdates: vi.fn().mockResolvedValue({
          updateAvailable: true,
          currentVersion: '2.0.0',
          latestVersion: '2.0.1-beta.1',
          releaseNotes: 'Beta fixes',
          publishedAt: '2026-03-31T00:00:00Z',
          url: 'https://github.com/WaterGauge/redactera/releases/tag/v2.0.1-beta.1',
          prerelease: true,
        }),
        openReleasePage: vi.fn().mockResolvedValue({ success: true }),
      },
      registerCoreHandlers: vi.fn(),
    };
  });

  it('registers version and update IPC handlers including legacy aliases', () => {
    registerIpcHandlers({
      ipcMain: mockIpcMain as any,
      ...mockDependencies,
    });

    expect(mockHandlers.has('app:getVersion')).toBe(true);
    expect(mockHandlers.has('version:get')).toBe(true);
    expect(mockHandlers.has('updates:getChangelog')).toBe(true);
    expect(mockHandlers.has('updates:check')).toBe(true);
    expect(mockHandlers.has('app:checkForUpdates')).toBe(true);
    expect(mockHandlers.has('update:check')).toBe(true);
    expect(mockHandlers.has('updates:openReleasePage')).toBe(true);
    expect(mockHandlers.has('app:openReleasesPage')).toBe(true);
    expect(mockHandlers.has('update:openReleases')).toBe(true);
  });

  it('returns the current app version', async () => {
    registerIpcHandlers({
      ipcMain: mockIpcMain as any,
      ...mockDependencies,
    });

    const result = await mockHandlers.get('app:getVersion')?.({});

    expect(result).toBe('2.0.0');
  });

  it('returns the local changelog entries from v1.0.0 through the current version', async () => {
    registerIpcHandlers({
      ipcMain: mockIpcMain as any,
      ...mockDependencies,
    });

    const result = await mockHandlers.get('updates:getChangelog')?.({});

    expect(result).toEqual({
      entries: changelogEntries,
      currentVersion: '2.0.0',
    });
  });

  it('passes the includePrerelease option through to the update service', async () => {
    registerIpcHandlers({
      ipcMain: mockIpcMain as any,
      ...mockDependencies,
    });

    const result = await mockHandlers.get('updates:check')?.({}, { includePrerelease: true });

    expect(mockDependencies.updateService.checkForUpdates).toHaveBeenCalledWith({
      currentVersion: '2.0.0',
      includePrerelease: true,
      timeoutMs: 10000,
    });
    expect(result).toMatchObject({
      updateAvailable: true,
      latestVersion: '2.0.1-beta.1',
      prerelease: true,
    });
  });

  it('opens the release page externally', async () => {
    registerIpcHandlers({
      ipcMain: mockIpcMain as any,
      ...mockDependencies,
    });

    const result = await mockHandlers.get('updates:openReleasePage')?.({});

    expect(mockDependencies.updateService.openReleasePage).toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  it('returns a structured update error for renderer consumption', async () => {
    mockDependencies.updateService.checkForUpdates.mockRejectedValueOnce(new Error('offline'));

    registerIpcHandlers({
      ipcMain: mockIpcMain as any,
      ...mockDependencies,
    });

    const result = await mockHandlers.get('updates:check')?.({}, { includePrerelease: false });

    expect(result).toEqual({
      updateAvailable: false,
      currentVersion: '2.0.0',
      latestVersion: '2.0.0',
      error: {
        code: 'UPDATE_CHECK_FAILED',
        message: 'offline',
      },
    });
  });
});
