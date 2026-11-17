import fs from 'fs';
import path from 'path';
import type { App, BrowserWindow, Dialog, IpcMain, Shell, WebContents } from 'electron';
import { changelogEntries, type ChangelogEntry } from '../data/changelog';
import type { PathValidator, WriteTarget } from './pathValidator';
import { type FileExportResult, captureWriteTarget, writeExportFile } from './fileExport';
import type { FileSession } from './sessionFiles';
import type { SettingsManager } from './settingsManager';
import type { UpdateAuthority } from './distribution';
import type { PythonProcessManager } from './pythonProcessManager';
import { diagnosticErrorKind } from './diagnostics';
import { createDroppedPdfImporter, PdfImportLimitError } from './fileImport';

const GITHUB_REPO = 'WaterGauge/redactera';
const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;
const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`;
const UPDATE_TIMEOUT_MS = 10000;

interface LoggerLike {
  log(message: string, level?: 'INFO' | 'ERROR' | 'WARN' | 'DEBUG'): void;
  initialize(logFolderPath: string, enabled: boolean): void;
}

interface ReleaseRecord {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
}

interface UpdateInfo {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  publishedAt?: string;
  url?: string;
  prerelease?: boolean;
}

interface UpdateError { code: string; message: string }
type UpdateCheckResult = UpdateInfo & ({ error?: undefined } | { updateAvailable: false; error: UpdateError });

interface UpdateService {
  getChangelog(currentVersion: string): ChangelogEntry[];
  checkForUpdates(options: {
    currentVersion: string;
    includePrerelease: boolean;
    timeoutMs: number;
  }): Promise<UpdateCheckResult>;
  openReleasePage(): Promise<{ success: boolean }>;
}

interface CoreIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>;
  app: Pick<App, 'getPath'>;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showSaveDialog'>;
  mainWindowProvider: () => BrowserWindow | null;
  pathValidator: PathValidator;
  settingsManager: SettingsManager;
  pythonProcessManager: PythonProcessManager;
  logger: LoggerLike;
  session?: FileSession;
  temporaryRoot?: () => string;
  pageUrl?: string;
  trackWrite?: <T>(write: () => Promise<T>) => Promise<T>;
  exportFileImpl?: (sourcePath: string, target: WriteTarget) => Promise<void | FileExportResult>;
  revealFile?: (filePath: string) => void;
  fsImpl?: Pick<typeof fs, 'readFileSync' | 'promises' | 'existsSync'>;
}

interface UpdateIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>;
  app: Pick<App, 'getVersion'>;
  shell: Pick<Shell, 'openExternal'>;
  updateAuthority: UpdateAuthority;
  updateService?: UpdateService;
  registerCoreHandlers?: (dependencies: CoreIpcDependencies) => void;
}

export type RegisterIpcHandlersDependencies = CoreIpcDependencies & UpdateIpcDependencies;

interface ParsedVersion {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
  raw: string;
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

function parseVersion(version: string): ParsedVersion | null {
  const normalized = normalizeVersion(version);
  const match = normalized.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) {
    return null;
  }

  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^0\d+$/.test(part))) return null;

  return { major: match[1], minor: match[2], patch: match[3], prerelease, raw: normalized };
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }

  const maxLength = Math.max(a.length, b.length);
  for (let index = 0; index < maxLength; index += 1) {
    const left = a[index];
    const right = b[index];

    if (left === undefined) {
      return -1;
    }
    if (right === undefined) {
      return 1;
    }

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);

    if (leftNumeric && rightNumeric) {
      const diff = compareNumeric(left, right);
      if (diff !== 0) {
        return diff;
      }
      continue;
    }

    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }

    if (left !== right) return left < right ? -1 : 1;
  }

  return 0;
}

function compareVersions(leftVersion: string, rightVersion: string): number {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);

  if (!left || !right) {
    return normalizeVersion(leftVersion).localeCompare(normalizeVersion(rightVersion));
  }

  return compareNumeric(left.major, right.major) || compareNumeric(left.minor, right.minor) ||
    compareNumeric(left.patch, right.patch) || comparePrerelease(left.prerelease, right.prerelease);
}

function createStructuredError(code: string, message: string): UpdateError {
  return { code, message };
}

function getChangelogForVersion(currentVersion: string): ChangelogEntry[] {
  return changelogEntries.filter((entry) => compareVersions(entry.version, currentVersion) <= 0)
    .sort((left, right) => compareVersions(left.version, right.version));
}

function createDefaultUpdateService(dependencies: {
  shell: Pick<Shell, 'openExternal'>;
  fetchImpl?: typeof fetch;
}): UpdateService {
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  return {
    getChangelog(currentVersion: string): ChangelogEntry[] {
      return getChangelogForVersion(currentVersion);
    },

    async checkForUpdates({
      currentVersion,
      includePrerelease,
      timeoutMs,
    }: {
      currentVersion: string;
      includePrerelease: boolean;
      timeoutMs: number;
    }): Promise<UpdateCheckResult> {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(GITHUB_RELEASES_API_URL, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'PDF-Desensitization',
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`GitHub Releases API returned ${response.status}`);
        }

        const data: unknown = await response.json();
        if (!Array.isArray(data) || data.some(release => {
          if (!isRecord(release)) return true;
          const version = release.tag_name ?? release.name;
          return typeof version !== 'string' || !version.trim() ||
            (release.draft !== undefined && typeof release.draft !== 'boolean') ||
            (release.prerelease !== undefined && typeof release.prerelease !== 'boolean');
        })) {
          throw new Error('GitHub Releases API returned invalid release data');
        }
        const releases = data as ReleaseRecord[];
        const current = parseVersion(currentVersion);

        const candidates = releases
          .filter((release) => !release.draft)
          .map((release) => {
            const version = release.tag_name ?? release.name ?? '';
            return { version, release, parsed: parseVersion(version) };
          })
          .filter((entry) => entry.parsed !== null)
          .filter((entry) => includePrerelease || (!entry.release.prerelease && !entry.parsed?.prerelease.length))
          .filter((entry) => current === null || compareVersions(entry.version, current.raw) > 0)
          .sort((left, right) => compareVersions(right.version, left.version));

        if (candidates.length === 0) {
          return {
            updateAvailable: false,
            currentVersion,
            latestVersion: currentVersion,
          };
        }

        const newest = candidates[0];
        return {
          updateAvailable: true,
          currentVersion,
          latestVersion: normalizeVersion(newest.version),
          releaseNotes: newest.release.body ?? '',
          publishedAt: newest.release.published_at,
          url: newest.release.html_url,
          prerelease: Boolean(newest.release.prerelease || newest.parsed?.prerelease.length),
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },

    async openReleasePage(): Promise<{ success: boolean }> {
      await dependencies.shell.openExternal(GITHUB_RELEASES_URL);
      return { success: true };
    },
  };
}


type PdfAction = 'upload' | 'desensitize' | 'export';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateProcessingRequest(request: unknown, validator: PathValidator): {
  action: PdfAction; payload: Record<string, unknown> & { file_path: string }; operationId?: string;
} {
  if (!isRecord(request) || !isRecord(request.payload) ||
      Object.keys(request).some(key => !['action', 'payload', 'operationId'].includes(key))) {
    throw new Error('Invalid PDF request');
  }
  const { action, payload } = request;
  if ('operationId' in request && (typeof request.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.operationId))) {
    throw new Error('Invalid operation identity');
  }
  if (action !== 'upload' && action !== 'desensitize' && action !== 'export') {
    throw new Error('Unsupported PDF action');
  }
  const fields = action === 'upload' ? ['file_path']
    : action === 'desensitize' ? ['file_path', 'keywords', 'settings'] : ['file_path', 'format', 'dpi'];
  // Renderer-chosen output paths never reach Python. Final copies use the
  // separate Main file:copy operation and its save-dialog authorization.
  if (Object.keys(payload).some(key => !fields.includes(key))) {
    throw new Error('Unsupported PDF payload field');
  }
  const source = typeof payload.file_path === 'string' ? validator.resolveUserPath(payload.file_path) : null;
  if (!source || !validator.isResolvedPathAllowed(source)) {
    throw new Error('Access denied: source file is not allowlisted');
  }
  const forwarded: Record<string, unknown> & { file_path: string } = { file_path: source };
  if (action === 'desensitize') {
    if (!Array.isArray(payload.keywords) || !payload.keywords.length ||
        payload.keywords.some(keyword => typeof keyword !== 'string' || !keyword.trim())) {
      throw new Error('Invalid PDF keywords');
    }
    if (payload.settings !== undefined && !isRecord(payload.settings)) {
      throw new Error('Invalid PDF settings');
    }
    forwarded.keywords = [...payload.keywords];
    forwarded.settings = payload.settings ?? {};
  } else if (action === 'export') {
    if (payload.format !== 'pdf' && payload.format !== 'png' && payload.format !== 'png_zip') {
      throw new Error('Unsupported export format');
    }
    forwarded.format = payload.format;
    if (payload.dpi !== undefined) {
      if (typeof payload.dpi !== 'number' || !Number.isInteger(payload.dpi) || ![150, 200, 300].includes(payload.dpi)) {
        throw new Error('Invalid export DPI');
      }
      forwarded.dpi = payload.dpi;
    }
  }
  return { action, payload: forwarded, operationId: request.operationId as string | undefined };
}

export function registerCoreHandlers({
  ipcMain,
  app,
  dialog,
  mainWindowProvider,
  pathValidator,
  settingsManager,
  pythonProcessManager,
  logger,
  fsImpl = fs,
  session,
  temporaryRoot = () => session?.directory ?? app.getPath('temp'),
  trackWrite = write => write(),
  exportFileImpl = (source, target) => writeExportFile(source, target, fsImpl, session),
  revealFile,
  pageUrl,
}: CoreIpcDependencies): void {
  let saveSequence = 0;
  let copying = false;
  let lastExport: { sender: WebContents; filePath: string } | null = null;
  const requirePersistentLogFolder = (folder: unknown): void => {
    if (session && typeof folder === 'string' && folder.trim() &&
        session.isManagedPath(path.join(folder, 'application-log.txt'))) {
      throw new Error('Please choose a log folder outside application temporary storage');
    }
  };
  ipcMain.handle('dialog:openFile', async (_event, options) => {
    const mainWindow = mainWindowProvider();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window not available');
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      ...options,
      properties: ['openFile'],
      filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
    });

    if (!result.canceled && result.filePaths.length > 1) throw new Error('请一次选择一个 PDF 文件。');
    if (!result.canceled && result.filePaths.length === 1) {
      pathValidator.addAllowedPath(result.filePaths[0]);
    }

    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('dialog:saveFile', async (_event, options) => {
    if (copying) throw new Error('An export is already in progress');
    const sequence = ++saveSequence;
    pathValidator.clearWriteTarget();
    const mainWindow = mainWindowProvider();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window not available');
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      ...options,
    });

    if (sequence !== saveSequence || result.canceled || !result.filePath) return null;
    const selectedPath = pathValidator.resolveUserPath(result.filePath);
    if (!selectedPath) throw new Error('Invalid save destination');
    const target = await captureWriteTarget(selectedPath, fsImpl);
    if (session?.isManagedPath(selectedPath)) throw new Error('Please save outside application temporary storage');
    if (sequence !== saveSequence) return null;
    pathValidator.setWriteTarget(target);
    return selectedPath;
  });

  type OwnedOperation = { id?: string; sender: WebContents; cancelled: boolean; done: Promise<void>; settled: () => void };
  let processing: OwnedOperation | null = null;
  let completed: OwnedOperation | null = null;
  ipcMain.handle('pdf:cancel', async (event, operationId: unknown) => {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error('Invalid operation identity');
    const work = processing;
    if (!work) return completed?.id === operationId && completed.sender === event.sender
      ? pythonProcessManager.cancel() : { confirmed: false };
    if (work.id !== operationId || work.sender !== event.sender) return { confirmed: false };
    work.cancelled = true;
    const result = await pythonProcessManager.cancel();
    await work.done;
    return result;
  });
  ipcMain.handle('pdf:process', async (event, request: unknown) => {
    const { action, payload, operationId } = validateProcessingRequest(request, pathValidator);
    if (processing) throw new Error('Python backend is busy');
    let settled!: () => void;
    const work = { id: operationId, sender: event.sender, cancelled: false,
      done: new Promise<void>(resolve => { settled = resolve; }), settled: () => settled() };
    processing = work;
    let retainedDirectory: string | undefined;
    let published = false;
    try {
      logger.log(`Processing PDF action: ${action}`);
      logger.log(`PDF request accepted; keywords=${Array.isArray(payload.keywords) ? payload.keywords.length : 0}`, 'DEBUG');
      const result = await (operationId === undefined ? pythonProcessManager.send(action, payload)
        : pythonProcessManager.send(action, payload, { onProgress: progress => {
          if (processing === work && !work.cancelled && !work.sender.isDestroyed()) {
            work.sender.send('pdf:progress', { ...progress, operationId });
          }
        } }));
      if (work.cancelled) throw new Error('Request cancelled');
      if (!isRecord(result)) throw new Error('Invalid PDF response');

      if (action === 'upload') return result;
      if (action === 'export' && payload.format === 'pdf') {
        if (typeof result.output_path !== 'string' ||
            pathValidator.resolveUserPath(result.output_path) !== payload.file_path) {
          throw new Error('Invalid PDF export response');
        }
        // PDF export without a target only echoes an existing grant.
        return { ...result, output_path: payload.file_path };
      }

      const field = action === 'desensitize' ? 'output_path' : payload.format === 'png' ? 'output_files' : 'zip_path';
      const output = result[field];
      const candidates = field === 'output_files' ? output : [output];
      if (!Array.isArray(candidates)) throw new Error('Invalid generated files');
      const tempRoot = await fsImpl.promises.realpath(temporaryRoot());
      const verified = await Promise.all(candidates.map(async (candidate: unknown) => {
        if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0')) {
          throw new Error('Invalid generated path');
        }
        const resolved = await fsImpl.promises.realpath(candidate);
        const info = await fsImpl.promises.lstat(candidate);
        if (!info.isFile() || !pathValidator.isPathInsideDirectory(resolved, tempRoot)) {
          throw new Error('Access denied: invalid generated file');
        }
        return resolved;
      }));
      // Validate the complete response before granting any path. Never scan
      // arbitrary response keys or turn a failed batch into partial access.
      if (work.cancelled) throw new Error('Request cancelled');
      let retained = verified;
      if (session) {
        // Python cleans its generation on EOF. Completed results must outlive
        // cancellation of a later task that uses them as input.
        retained = await trackWrite(async () => {
          const directory = await fsImpl.promises.mkdtemp(path.join(tempRoot, 'result-'));
          retainedDirectory = directory;
          const copies: string[] = [];
          const extension = field === 'output_path' ? '.pdf' : field === 'output_files' ? '.png' : '.zip';
          for (const [index, file] of verified.entries()) {
            const target = path.join(directory, `${index}${extension}`);
            await fsImpl.promises.copyFile(file, target, fs.constants.COPYFILE_EXCL);
            copies.push(target);
          }
          return copies;
        });
      }
      if (work.cancelled) throw new Error('Request cancelled');
      retained.forEach(file => pathValidator.addAllowedPath(file));
      published = true;
      logger.log(`PDF action completed: ${action}`);
      return { ...result, [field]: field === 'output_files' ? retained : retained[0] };
    } finally {
      if (retainedDirectory && !published) {
        try { await fsImpl.promises.rm(retainedDirectory, { recursive: true, force: true }); }
        catch (error) { logger.log(`Unpublished result retained for session cleanup: ${diagnosticErrorKind(error)}`, 'WARN'); }
      }
      if (processing === work) { completed = work; processing = null; }
      work.settled();
    }
  });

  ipcMain.handle('pdf:readFile', (_event, filePath: string) => {
    const resolvedPath = pathValidator.resolveUserPath(filePath);
    if (!resolvedPath || !pathValidator.isResolvedPathAllowed(resolvedPath)) {
      throw new Error('Access denied: file not in allowed paths');
    }

    return fsImpl.readFileSync(resolvedPath, 'base64');
  });

  ipcMain.handle('settings:get', (_event, includeCredentials?: boolean) =>
    includeCredentials === false ? settingsManager.readPreferences() : settingsManager.readSettings());

  ipcMain.handle('settings:save', (_event, settings, includeCredentials?: boolean) => {
    requirePersistentLogFolder(settings?.log_folder_path);
    if (includeCredentials === false) settingsManager.writePreferences(settings);
    else settingsManager.writeSettings(settings);
    logger.initialize(settings.log_folder_path, settings.developer_mode);
    return { success: true };
  });

  ipcMain.handle(
    'settings:validateBaidu',
    async (_event, { apiKey, secretKey }: { apiKey: string; secretKey: string }) => ({
      valid: await settingsManager.validateBaiduKeys(apiKey, secretKey),
    })
  );

  ipcMain.handle('get-developer-mode', () => {
    const settings = settingsManager.readPreferences();
    return {
      enabled: settings.developer_mode,
      logFolderPath: settings.log_folder_path,
    };
  });

  ipcMain.handle('set-developer-mode', (_event, enabled: boolean) => {
    const settings = settingsManager.readPreferences();
    if (enabled) requirePersistentLogFolder(settings.log_folder_path);
    settings.developer_mode = enabled;
    settingsManager.writePreferences(settings);
    logger.initialize(settings.log_folder_path, enabled);
    return { success: true };
  });

  ipcMain.handle('select-log-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择日志文件夹',
      buttonLabel: '选择',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false };
    }

    const folderPath = result.filePaths[0];
    requirePersistentLogFolder(folderPath);
    return { success: true, path: folderPath };
  });

  ipcMain.handle('file:copy', async (event, sourcePath: string, destPath: string) => {
    if (copying) throw new Error('An export is already in progress');
    const resolvedSourcePath = pathValidator.resolveUserPath(sourcePath);
    const resolvedDestPath = pathValidator.resolveUserPath(destPath);

    if (!resolvedSourcePath || !pathValidator.isResolvedPathAllowed(resolvedSourcePath)) {
      throw new Error('Access denied: source file is not allowlisted');
    }

    // Consent is consumed synchronously before the first disk await.
    const target = pathValidator.claimWriteTarget(resolvedDestPath);
    if (!target) throw new Error('Access denied: destination was not selected for this export');
    copying = true;
    try {
      const exported = await exportFileImpl(resolvedSourcePath, target);
      if (exported?.cleanupWarning) logger.log('Export completed; temporary directory cleanup failed', 'WARN');
      pathValidator.addAllowedPath(target.filePath);
      lastExport = { sender: event.sender, filePath: path.join(target.realParent, path.basename(target.filePath)) };
      return { success: true };
    } finally {
      copying = false;
    }
  });

  ipcMain.handle('file:revealExport', async (event, payload: unknown) => {
    const window = mainWindowProvider(), exported = lastExport;
    if (payload !== undefined || !revealFile || !window || window.isDestroyed() ||
        event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== event.sender.mainFrame ||
        !exported || exported.sender !== event.sender) throw new Error('Access denied: no export for this window');
    if (!(await fsImpl.promises.lstat(exported.filePath)).isFile() || lastExport !== exported) {
      throw new Error('Exported file is no longer available');
    }
    revealFile(exported.filePath);
    return { success: true };
  });

  const importDropped = createDroppedPdfImporter({ temporaryRoot, pathValidator, fsImpl });
  ipcMain.handle('file:saveDragged', async (event, payload: unknown) => {
    const isOwner = () => {
      try {
        const window = mainWindowProvider();
        const owner = window && !window.isDestroyed() ? window.webContents : null;
        const frame = event.senderFrame;
        return Boolean(pageUrl && owner && !owner.isDestroyed() && event.sender === owner &&
          frame && frame === owner.mainFrame && new URL(frame.url).href === new URL(pageUrl).href);
      } catch { return false; }
    };
    if (!isOwner()) return null;
    try { return await importDropped(payload, isOwner); }
    catch (error) {
      if (error instanceof PdfImportLimitError) throw new Error(error.message);
      return null;
    }
  });
}

export function registerIpcHandlers(dependencies: RegisterIpcHandlersDependencies): void {
  const {
    ipcMain,
    app,
    shell,
    updateAuthority,
    updateService = createDefaultUpdateService({ shell }),
    registerCoreHandlers: registerCoreHandlersOverride,
  } = dependencies;

  const currentVersion = app.getVersion();

  if (registerCoreHandlersOverride) {
    registerCoreHandlersOverride(dependencies);
  } else {
    registerCoreHandlers(dependencies);
  }

  const versionHandler = () => currentVersion;
  ipcMain.handle('app:getVersion', versionHandler);
  ipcMain.handle('version:get', versionHandler);

  ipcMain.handle('updates:getChangelog', () => ({
    entries: updateService.getChangelog(currentVersion),
    currentVersion,
  }));

  const checkHandler = async (
    _event: unknown,
    options?: { includePrerelease?: boolean }
  ): Promise<UpdateCheckResult> => {
    if (updateAuthority !== 'github-manual') {
      return { updateAvailable: false, currentVersion, latestVersion: currentVersion,
        error: createStructuredError('UPDATE_MANAGED_EXTERNALLY', 'Updates are not managed by this application channel') };
    }
    const includePrerelease = Boolean(options?.includePrerelease);

    try {
      return await updateService.checkForUpdates({
        currentVersion,
        includePrerelease,
        timeoutMs: UPDATE_TIMEOUT_MS,
      });
    } catch (error) {
      return {
        updateAvailable: false,
        currentVersion,
        latestVersion: currentVersion,
        error: createStructuredError(
          error instanceof Error && error.name === 'AbortError'
            ? 'UPDATE_CHECK_TIMEOUT'
            : 'UPDATE_CHECK_FAILED',
          error instanceof Error ? error.message : 'Unknown update error'
        ),
      };
    }
  };

  ipcMain.handle('updates:check', checkHandler);
  ipcMain.handle('app:checkForUpdates', checkHandler);
  ipcMain.handle('update:check', checkHandler);

  const openReleasePageHandler = async (): Promise<{ success: boolean; error?: UpdateCheckResult['error'] }> => {
    if (updateAuthority !== 'github-manual') {
      return { success: false, error: createStructuredError('UPDATE_MANAGED_EXTERNALLY', 'Updates are not managed by this application channel') };
    }
    try {
      return await updateService.openReleasePage();
    } catch (error) {
      return {
        success: false,
        error: createStructuredError(
          'OPEN_RELEASE_PAGE_FAILED',
          error instanceof Error ? error.message : 'Unknown release page error'
        ),
      };
    }
  };

  ipcMain.handle('updates:openReleasePage', openReleasePageHandler);
  ipcMain.handle('app:openReleasesPage', openReleasePageHandler);
  ipcMain.handle('update:openReleases', openReleasePageHandler);
}

export const updateConstants = {
  GITHUB_RELEASES_URL,
  GITHUB_RELEASES_API_URL,
  UPDATE_TIMEOUT_MS,
};
