import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppSettings } from './types/settings';
import type { OperationProgress } from './types/processing';
import { PDF_IMPORT_ERRORS, PDF_IMPORT_LIMITS } from './types/fileImport';

declare global {
  interface Window {
    electronAPI: {
      openFile(): Promise<string[]>;
      saveFile(options: {defaultPath?: string, filters?: Array<{name: string, extensions: string[]}>}): Promise<string | undefined>;
      processAction(action: string, payload: Record<string, unknown>, operationId?: string): Promise<unknown>;
      cancelAction(operationId: string): Promise<{ confirmed: boolean }>;
      onProcessingProgress(callback: (data: OperationProgress) => void): () => void;
      readFileAsBase64(filePath: string): Promise<string>;
      readPdfPreview(filePath: string): Promise<Uint8Array>;
      importDroppedFile(file: File): Promise<string | null>;
      getSettings(includeCredentials?: boolean): Promise<AppSettings>;
      saveSettings(settings: AppSettings, includeCredentials?: boolean): Promise<{ success: boolean }>;
      getAppVersion(): Promise<string>;
      getChangelog(): Promise<{ currentVersion: string; entries: Array<{ version: string; publishedAt: string; summary: string }> }>;
      checkForUpdates(options: { includePrerelease: boolean }): Promise<unknown>;
      openReleasePage(): Promise<{ success: boolean }>;
      openReleasesPage(): Promise<{ success: boolean }>;
      validateBaidu(keys: { apiKey: string; secretKey: string }): Promise<{ valid: boolean }>;
      onPythonCrashed(callback: (data: { code: number | null }) => void): () => void;
      copyFile(sourcePath: string, destPath: string): Promise<{ success: boolean }>;
      revealLastExport(): Promise<{ success: boolean }>;
      getDeveloperMode(): Promise<{ enabled: boolean; logFolderPath: string }>;
      setDeveloperMode(enabled: boolean): Promise<{ success: boolean }>;
      selectLogFolder(): Promise<{ success: boolean; path?: string }>;
    };
  }
}

let pendingDroppedImports = 0;

contextBridge.exposeInMainWorld('electronAPI', {
  openFile(): Promise<string[]> {
    return ipcRenderer.invoke('dialog:openFile');
  },

  saveFile(options: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | undefined> {
    return ipcRenderer.invoke('dialog:saveFile', options);
  },

  processAction(action: string, payload: Record<string, unknown>, operationId?: string): Promise<unknown> {
    return ipcRenderer.invoke('pdf:process', { action, payload, ...(operationId === undefined ? {} : { operationId }) });
  },

  cancelAction(operationId: string): Promise<{ confirmed: boolean }> {
    return ipcRenderer.invoke('pdf:cancel', operationId);
  },

  onProcessingProgress(callback: (data: OperationProgress) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, data: OperationProgress) => callback(data);
    ipcRenderer.on('pdf:progress', listener);
    return () => { ipcRenderer.removeListener('pdf:progress', listener); };
  },

  readFileAsBase64(filePath: string): Promise<string> {
    return ipcRenderer.invoke('pdf:readFile', filePath);
  },

  readPdfPreview(filePath: string): Promise<Uint8Array> {
    return ipcRenderer.invoke('pdf:readPreview', filePath);
  },

  async importDroppedFile(file: File): Promise<string | null> {
    let sourcePath: string, fileName: string, size: number;
    try {
      // Only Electron's genuine File provenance can supply a native path.
      sourcePath = webUtils.getPathForFile(file);
      const getName = Object.getOwnPropertyDescriptor(File.prototype, 'name')?.get;
      const getSize = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get;
      if (!getName || !getSize) return null;
      fileName = getName.call(file);
      size = getSize.call(file);
    } catch { return null; }
    if (fileName.length > PDF_IMPORT_LIMITS.nameLength || !/\.pdf$/i.test(fileName) ||
        !Number.isSafeInteger(size) || size < 5) return null;
    if (size > PDF_IMPORT_LIMITS.fileBytes) throw new Error(PDF_IMPORT_ERRORS.fileSize);
    if (pendingDroppedImports >= PDF_IMPORT_LIMITS.concurrent) throw new Error(PDF_IMPORT_ERRORS.busy);
    pendingDroppedImports += 1;
    try {
      if (sourcePath) {
        return await ipcRenderer.invoke('file:saveDragged', { kind: 'path', fileName, sourcePath, size });
      }
      if (size > PDF_IMPORT_LIMITS.virtualBytes) throw new Error(PDF_IMPORT_ERRORS.virtualSize);
      const bytes = new Uint8Array(await Blob.prototype.arrayBuffer.call(file));
      if (bytes.byteLength !== size) return null;
      return await ipcRenderer.invoke('file:saveDragged', { kind: 'bytes', fileName, bytes });
    } finally { pendingDroppedImports -= 1; }
  },

  getSettings(includeCredentials = true): Promise<AppSettings> {
    return ipcRenderer.invoke('settings:get', includeCredentials);
  },

  saveSettings(settings: AppSettings, includeCredentials = true): Promise<{ success: boolean }> {
    return ipcRenderer.invoke('settings:save', settings, includeCredentials);
  },

  async getAppVersion(): Promise<string> {
    try {
      return await ipcRenderer.invoke('app:getVersion');
    } catch {
      return ipcRenderer.invoke('version:get');
    }
  },

  getChangelog(): Promise<{ currentVersion: string; entries: Array<{ version: string; publishedAt: string; summary: string }> }> {
    return ipcRenderer.invoke('updates:getChangelog');
  },

  async checkForUpdates(options: { includePrerelease: boolean }): Promise<unknown> {
    try {
      return await ipcRenderer.invoke('app:checkForUpdates', options);
    } catch {
      return ipcRenderer.invoke('update:check', options);
    }
  },

  async openReleasePage(): Promise<{ success: boolean }> {
    try {
      return await ipcRenderer.invoke('app:openReleasesPage');
    } catch {
      return ipcRenderer.invoke('update:openReleases');
    }
  },

  openReleasesPage(): Promise<{ success: boolean }> {
    return this.openReleasePage();
  },

  validateBaidu(keys: { apiKey: string; secretKey: string }): Promise<{ valid: boolean }> {
    return ipcRenderer.invoke('settings:validateBaidu', keys);
  },

  onPythonCrashed(callback: (data: { code: number | null }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, data: { code: number | null }) => callback(data);
    ipcRenderer.on('python:crashed', listener);
    return () => { ipcRenderer.removeListener('python:crashed', listener); };
  },

  copyFile(sourcePath: string, destPath: string): Promise<{ success: boolean }> {
    return ipcRenderer.invoke('file:copy', sourcePath, destPath);
  },

  revealLastExport(): Promise<{ success: boolean }> {
    return ipcRenderer.invoke('file:revealExport');
  },

  getDeveloperMode(): Promise<{ enabled: boolean; logFolderPath: string }> {
    return ipcRenderer.invoke('get-developer-mode');
  },

  setDeveloperMode(enabled: boolean): Promise<{ success: boolean }> {
    return ipcRenderer.invoke('set-developer-mode', enabled);
  },

  selectLogFolder(): Promise<{ success: boolean; path?: string }> {
    return ipcRenderer.invoke('select-log-folder');
  },
});
