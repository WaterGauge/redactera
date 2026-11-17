import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, shell } from 'electron';
import path from 'path';
import { execFileSync } from 'node:child_process';
import pkg from '../package.json';
import { logger } from './logger';
import { registerIpcHandlers } from './main/ipcHandlers';
import { createPathValidator } from './main/pathValidator';
import { createPythonProcessManager } from './main/pythonProcessManager';
import { createFileSession, type FileSession } from './main/sessionFiles';
import { createFileLifecycle, installFileShutdown } from './main/fileLifecycle';
import { createSettingsManager } from './main/settingsManager';
import { createPdfPreviewHandler, registerPdfPreviewReader, registerPdfPreviewScheme } from './main/pdfPreview';
import { diagnosticErrorKind } from './main/diagnostics';
import { macApplicationMenu } from './main/applicationMenu';
import { createWindowsRecoveryProbe } from './main/windowsRecovery';
import { updateWindowsInstallIcon, updateWindowsShortcuts, windowsAppUserModelId } from './main/windowsShortcuts';
import { BACKEND_CONTRACT } from './main/backendContract';
import { captureDesktopProfile, desktopDistribution } from './main/distribution';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const isTestEnvironment = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
const distribution = isTestEnvironment ? null : desktopDistribution({ windowsStore: process.windowsStore, mas: process.mas });
// Reject unsupported packaged contexts before legacy installation hooks, settings,
// credentials, Chromium windows or document-session recovery can run.
if (!isTestEnvironment && !distribution) {
  dialog.showErrorBox('不支持的发行渠道', '此版本尚未支持当前应用包身份。请使用正式桌面安装版。');
  app.exit(1);
}
const shouldBootstrapApp = distribution !== null && !handleSquirrelStartup();
if (!isTestEnvironment && distribution && !shouldBootstrapApp) app.quit();
const profile = shouldBootstrapApp ? captureDesktopProfile(app.getPath('userData'), app.getPath('sessionData')) : undefined;

function handleSquirrelStartup(): boolean {
  if (process.platform !== 'win32') return false;
  const executable = process.execPath;
  const binary = path.basename(executable);
  const event = process.argv[1];
  const installing = event === '--squirrel-install' || event === '--squirrel-updated';
  const uninstalling = event === '--squirrel-uninstall';

  if (app.isPackaged && binary.toLowerCase() === `${pkg.branding.name}.exe`.toLowerCase()) {
    app.setAppUserModelId(windowsAppUserModelId);
    if (!uninstalling) {
      try { updateWindowsInstallIcon(executable, path.join(process.resourcesPath, 'icon.ico')); }
      catch (error) { console.warn('Unable to update Windows installation icon:', diagnosticErrorKind(error)); }
    }
    if (installing || uninstalling) {
      try {
        if (installing) {
          const update = path.resolve(path.dirname(executable), '..', 'Update.exe');
          // Localize the stock desktop link only after Update.exe has created it.
          execFileSync(update, [`--createShortcut=${binary}`], { windowsHide: true, stdio: 'ignore', timeout: 8000 });
        }
        updateWindowsShortcuts(executable, app.getPath('desktop'), app.getPath('appData'), shell,
          app.getPreferredSystemLanguages()[0], uninstalling ? 'uninstall' : 'install');
        if (installing) return true;
      } catch (error) {
        console.warn('Unable to localize Windows shortcuts:', diagnosticErrorKind(error));
      }
    }
  }

  // Keep the Squirrel handler after the controlled shortcut migration.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return Boolean(require('electron-squirrel-startup'));
}

// Electron requires scheme privileges before app.ready, exactly once.
if (shouldBootstrapApp) registerPdfPreviewScheme(protocol);

const pathValidator = createPathValidator();
const settingsManager = createSettingsManager({
  app,
  safeStorage,
  profileDirectory: profile?.userData,
});

let mainWindow: BrowserWindow | null = null;
let fileSession: FileSession | undefined;
const fileLifecycle = createFileLifecycle();

const pythonProcessManager = createPythonProcessManager({
  app,
  logger,
  readSettings: () => {
    const settings = settingsManager.readPreferences();
    if (fileSession && settings.log_folder_path &&
        fileSession.isManagedPath(path.join(settings.log_folder_path, 'application-log.txt'))) {
      return { ...settings, developer_mode: false };
    }
    return settings;
  },
  prepareLaunch: () => {
    if (!fileSession) throw new Error('File session is not ready');
    return fileSession.prepareBackend();
  },
  onProcessCrashed: ({ code }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python:crashed', { code });
    }
  },
  onFailedToStart: ({ error }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python:failed-to-start', { error });
    }
  },
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: pkg.branding.nameZh,
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    ...(process.platform === 'win32' ? { icon: app.isPackaged ? path.join(process.resourcesPath, 'icon.ico')
      : path.join(app.getAppPath(), 'assets', 'icon.ico') } : {}),
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
}

if (shouldBootstrapApp && distribution && profile) {
  app.whenReady().then(() => {
    if (process.platform === 'darwin') {
      if (!app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), 'assets', 'redactera-macos.png'));
      Menu.setApplicationMenu(Menu.buildFromTemplate(macApplicationMenu(app.getPreferredSystemLanguages())));
    } else if (process.platform === 'win32') {
      Menu.setApplicationMenu(null);
    }
    app.setAboutPanelOptions({ applicationName: pkg.branding.nameZh });
    const settings = settingsManager.readPreferences();
    fileSession = createFileSession({
      baseDirectory: profile.fileSessions,
      preservePaths: settings.log_folder_path ? [settings.log_folder_path] : [],
      windowsProbe: process.platform === 'win32' ? createWindowsRecoveryProbe({
        command: app.isPackaged ? path.join(process.resourcesPath, 'dist', 'python_backend.exe')
          : process.env.PDF_DESENSITIZATION_PYTHON || 'python',
        args: app.isPackaged ? [] : [path.join(app.getAppPath(), 'python-backend', 'main.py')],
        cwd: app.isPackaged ? process.resourcesPath : app.getAppPath(),
        expectedContract: BACKEND_CONTRACT,
      }) : undefined,
    });
    const temporaryLogFolder = !!settings.log_folder_path &&
      fileSession.isManagedPath(path.join(settings.log_folder_path, 'application-log.txt'));
    logger.initialize(settings.log_folder_path, settings.developer_mode && !temporaryLogFolder);
    logger.log('Electron app ready');
    installFileShutdown({
      app, lifecycle: fileLifecycle,
      closeWindows: () => {
        pathValidator.clearWriteTarget();
        BrowserWindow.getAllWindows().forEach(window => { if (!window.isDestroyed()) window.destroy(); });
      },
      stopBackend: () => pythonProcessManager.stop(),
      cleanup: () => fileSession?.cleanup() ?? true,
      logger,
    });

    const previewHandler = createPdfPreviewHandler({
      pathValidator, isClosing: () => fileLifecycle.closing,
      fetchFile: fileUrl => net.fetch(fileUrl),
    });
    protocol.handle('pdf-safe', previewHandler);
    registerPdfPreviewReader({ ipcMain: fileLifecycle.wrap(ipcMain), mainWindowProvider: () => mainWindow,
      pageUrl: MAIN_WINDOW_WEBPACK_ENTRY, handler: previewHandler });

    registerIpcHandlers({
      pageUrl: MAIN_WINDOW_WEBPACK_ENTRY,
      ipcMain: fileLifecycle.wrap(ipcMain),
      session: fileSession,
      trackWrite: fileLifecycle.trackWrite,
      app,
      shell,
      revealFile: filePath => shell.showItemInFolder(filePath),
      dialog,
      mainWindowProvider: () => mainWindow,
      pathValidator,
      settingsManager,
      updateAuthority: distribution.updateAuthority,
      pythonProcessManager,
      logger,
    });

    pythonProcessManager.start();
    createWindow();
    if (fileSession.recoveryWarnings || temporaryLogFolder) {
      const pending = fileSession.recoveryWarnings > 0;
      void dialog.showMessageBox({
        type: 'warning',
        message: pending ? '部分临时文件尚未清理' : '请重新选择日志目录',
        detail: [
          pending ? '无法确认部分临时文件是否仍在使用，已暂时保留。可查看文件位置；完全退出本软件后再手动清理。' : '',
          temporaryLogFolder ? '日志目录位于临时文件夹中。现有日志已保留，请在设置中选择其他目录。' : '',
        ].filter(Boolean).join('\n'),
        buttons: pending ? ['知道了', '查看临时文件'] : ['知道了'],
        defaultId: 0, cancelId: 0,
      }).then(result => {
        if (pending && result.response === 1 && fileSession) {
          void shell.openPath(path.dirname(fileSession.directory));
        }
      });
    }
  }).catch(error => {
    logger.log(`Startup failed: ${diagnosticErrorKind(error)}`, 'ERROR');
    dialog.showErrorBox(`无法启动${pkg.branding.nameZh}`, '无法建立安全的临时工作目录或启动后端，请检查磁盘空间和目录权限后重试。');
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (!fileLifecycle.closing && BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });


}
