import './index.css';
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import pkg from '../package.json';
import { SettingsModal } from './components/SettingsModal';
import { ProcessingWarnings } from './components/ProcessingWarnings';
import { ReviewRegions } from './components/ReviewRegions';
import { parseReviewReport, type ReviewReport, type ProcessingProgress } from './types/processing';
import { PdfPreview } from './components/PdfPreview';
import { ExportDialog, type ExportOptions } from './components/ExportDialog';
import type { AppSettings, DesensitizationWarning, SanitizationSummary } from './types/settings';
import { CREDENTIAL_STORAGE_MESSAGES, credentialStorageBlocked, DEFAULT_SETTINGS } from './types/settings';
import { userError } from './utils/userError';
import { backendStartupFailure } from './utils/backendStartupFailure';
import { readKeywords, keywordMaskCount, needsExportDecision, exportName } from './workflow';
import { readMotionPreference, writeMotionPreference, type MotionPreference } from './utils/uiPreferences';

const OCR_MODE_LABELS: Record<string, string> = {
  local: '本地识别',
  baidu: '百度 OCR',
  paddle: 'PaddleOCR 服务',
};

function SettingsIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}

function FileIcon() {
  return (
    <svg aria-hidden="true" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  );
}

interface InputSnapshot {
  readonly version: number;
  readonly filePath: string | null;
  readonly fileName: string | null;
  readonly keywords: readonly string[];
  readonly settings: Readonly<AppSettings>;
}
interface ProcessedResult {
  readonly input: InputSnapshot;
  readonly path: string;
  readonly warnings: DesensitizationWarning[];
  readonly sanitization?: SanitizationSummary;
  readonly review: ReviewReport;
}
interface ExportDraft {
  readonly input: InputSnapshot;
  readonly result: ProcessedResult | null;
}
interface PendingExport { readonly result: ProcessedResult; readonly options: ExportOptions; }
interface ExportDecision { readonly result: ProcessedResult; readonly options: ExportOptions | null; }
interface Operation {
  readonly id: number;
  readonly input: InputSnapshot;
  readonly writing: boolean;
  readonly backendId: string;
  readonly cancelling?: boolean;
  readonly exporting: boolean;
  readonly options: ExportOptions | null;
}
interface Session {
  input: InputSnapshot;
  result: ProcessedResult | null;
  operation: Operation | null;
  status: string;
  progress: ProcessingProgress | null;
  fileLoading: boolean;
  settingsReady: boolean;
  settingsOpen: boolean;
  backend: { operation: Operation; cancelling: boolean } | null;
  backendUnavailable: boolean;
  exportDialog: ExportDraft | null;
  pendingExport: ExportDecision | null;
  retryExport: PendingExport | null;
  previewError: ProcessedResult | null;
  saved: { path: string; result: ProcessedResult } | null;
}
function resultReady(current: Session): boolean {
  return !!current.result && current.result.input === current.input;
}

function App() {
  const [session, setSession] = useState<Session>(() => ({
    input: { version: 0, filePath: null, fileName: null, keywords: [], settings: { ...DEFAULT_SETTINGS } },
    result: null, operation: null, status: '', fileLoading: false, settingsReady: false, settingsOpen: false,
    backend: null, backendUnavailable: false, exportDialog: null, pendingExport: null, retryExport: null,
    previewError: null, progress: null, saved: null,
  }));
  // Event handlers and async continuations must see changes before React's
  // next render, including two clicks delivered in the same event batch.
  const sessionRef = useRef(session);
  const mounted = useRef(false);
  const operationSequence = useRef(0);
  const fileSequence = useRef(0);
  const settingsSequence = useRef(0);
  const [keywordText, setKeywordText] = useState('');
  const [motion, setMotion] = useState<MotionPreference>(readMotionPreference);
  const requestSequence = useRef(0);
  const exportMenuRef = useRef<HTMLDetailsElement>(null);
  const [previewSelection, setPreviewSelection] = useState<{ result: ProcessedResult; original: boolean } | null>(null);
  const previewSelectionRef = useRef(previewSelection);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const pendingExportFocus = useRef<Operation | null>(null);
  const [previewLocation, setPreviewLocation] = useState<{ result: ProcessedResult; page: number; sequence: number; regionId?: string } | null>(null);

  const commit = useCallback((next: Session) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const changeInput = (patch: Partial<Omit<InputSnapshot, 'version'>>, status: string, fileLoaded = false) => {
    const current = sessionRef.current;
    if (current.operation?.writing) return;
    commit({ ...current, input: { ...current.input, ...patch, version: current.input.version + 1 },
      result: null, operation: null, exportDialog: null, pendingExport: null, retryExport: null, previewError: null, progress: null, saved: null, status, fileLoading: fileLoaded ? false : current.fileLoading });
  };

  const refreshSettings = useCallback(async (credentialsEdited = false) => {
    if (!mounted.current) return;
    const request = ++settingsSequence.current;
    commit({ ...sessionRef.current, settingsReady: false, settingsOpen: false, exportDialog: null });
    try {
      const settings = { ...DEFAULT_SETTINGS, ...await window.electronAPI.getSettings(false) };
      if (!mounted.current || request !== settingsSequence.current) return;
      const current = sessionRef.current;
      const changed = credentialsEdited || (Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[])
        .some(key => current.input.settings[key] !== settings[key]);
      commit(changed ? {
        ...current, input: { ...current.input, settings, version: current.input.version + 1 },
        result: null, operation: null, pendingExport: null, retryExport: null, previewError: null, saved: null, settingsReady: true,
        status: '',
      } : { ...current, settingsReady: true });
    } catch (error) {
      if (!mounted.current || request !== settingsSequence.current) return;
      commit({ ...sessionRef.current, result: null, operation: null, pendingExport: null,
        status: '错误：' + userError(error, 'settings-read') });
    }
  }, [commit]);

  useEffect(() => {
    mounted.current = true;
    void refreshSettings();
    const unsubscribeCrash = window.electronAPI.onPythonCrashed(({ code }) => {
      if (!mounted.current) return;
      const current = sessionRef.current;
      commit({ ...current, input: { ...current.input, version: current.input.version + 1 }, result: null,
        operation: current.operation?.writing ? current.operation : null, exportDialog: null, pendingExport: null, retryExport: null, saved: null,
        status: '错误：' + (backendStartupFailure(code) ?? '处理服务意外停止，请重启应用') });
    });
    const unsubscribeProgress = window.electronAPI.onProcessingProgress(progress => {
      if (!mounted.current) return;
      const current = sessionRef.current, backend = current.backend;
      if (!backend || backend.cancelling || progress.operationId !== backend.operation.backendId ||
          current.operation?.id !== backend.operation.id || current.input !== backend.operation.input) return;
      commit({ ...current, status: progress.message, progress });
    });
    return () => {
      mounted.current = false; fileSequence.current++; settingsSequence.current++;
      unsubscribeCrash?.(); unsubscribeProgress();
    };
  }, [commit, refreshSettings]);

  useEffect(() => {
    const operation = pendingExportFocus.current;
    if (!operation || sessionRef.current !== session) return;
    pendingExportFocus.current = null;
    // A browser frame can precede React's commit. Restore focus only after
    // this render has actually removed the button's disabled attribute.
    if (mounted.current && !session.operation && !session.backend && !session.backendUnavailable &&
        session.input === operation.input && session.result?.input === operation.input && resultReady(session) &&
        session.settingsReady && !session.settingsOpen && !session.fileLoading && !session.exportDialog &&
        document.activeElement === document.body) exportButtonRef.current?.focus();
  }, [session]);

  const beginFileLoad = () => {
    const current = sessionRef.current;
    if (current.operation?.writing) return null;
    const request = ++fileSequence.current;
    const pendingExport = current.pendingExport && { ...current.pendingExport, options: null };
    commit({ ...current, fileLoading: true, exportDialog: null, pendingExport, retryExport: null, operation: null, progress: null });
    return request;
  };
  const isCurrentFileLoad = (request: number) => mounted.current && request === fileSequence.current;
  const finishFileLoad = (request: number, error?: unknown) => {
    if (!isCurrentFileLoad(request)) return;
    const current = sessionRef.current;
    commit({ ...current, fileLoading: false,
      status: error ? '错误：' + userError(error, 'open') : current.status });
  };
  const handleSelectFile = async () => {
    const request = beginFileLoad();
    if (request === null) return;
    try {
      const paths = await window.electronAPI.openFile();
      if (!isCurrentFileLoad(request)) return;
      if (paths?.length > 1) throw new Error('请一次选择一个 PDF 文件。');
      if (paths?.length) changeInput({ filePath: paths[0], fileName: paths[0].split(/[\\/]/).pop() ?? paths[0] }, '', true);
      else finishFileLoad(request);
    } catch (error) { finishFileLoad(request, error); }
  };
  const handleDrop = async (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault(); setIsDragOver(false);
    if (sessionRef.current.operation?.writing) return;
    if (e.dataTransfer.files.length > 1) {
      commit({ ...sessionRef.current, status: '请一次选择一个 PDF 文件。' }); return;
    }
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
      commit({ ...sessionRef.current, status: '错误：请拖入 PDF 文件' }); return;
    }
    const request = beginFileLoad();
    if (request === null) return;
    try {
      const path = await window.electronAPI.importDroppedFile(file);
      if (!isCurrentFileLoad(request)) return;
      if (!path) throw new Error('无法保存文件');
      changeInput({ filePath: path, fileName: file.name }, '', true);
    } catch (error) { finishFileLoad(request, error); }
  };

  const editKeywords = (text: string) => {
    const current = sessionRef.current;
    if (current.operation?.writing) return;
    setKeywordText(text);
    const keywords = readKeywords(text);
    if (keywords.length !== current.input.keywords.length || keywords.some((word, i) => word !== current.input.keywords[i])) {
      changeInput({ keywords }, '');
    }
  };
  const clearKeywords = () => { editKeywords(''); inputRef.current?.focus(); };
  const openSettings = () => {
    const current = sessionRef.current;
    if (current.operation?.writing) return;
    const pendingExport = current.pendingExport && { ...current.pendingExport, options: null };
    commit({ ...current, settingsOpen: true,
      exportDialog: null, pendingExport, retryExport: null, operation: null, progress: null });
  };
  const beginOperation = (status: string, options: ExportOptions | null, confirmed: ExportDecision | null) => {
    const current = sessionRef.current;
    if (current.operation || current.backend || current.backendUnavailable || current.fileLoading || !current.settingsReady || current.settingsOpen || current.exportDialog ||
        !current.input.filePath || !current.input.keywords.length) return null;
    const pending = current.pendingExport;
    if (options && pending && pending.result === current.result && pending !== confirmed) {
      commit({ ...current, status: '', pendingExport: { result: pending.result, options } });
      return null;
    }
    const operation: Operation = { id: ++operationSequence.current, input: current.input, writing: false,
      backendId: `ui_${crypto.randomUUID()}`, exporting: options !== null, options };
    commit({ ...current, operation, status, progress: null, pendingExport: null, retryExport: null, saved: null });
    return operation;
  };
  const isCurrentOperation = (operation: Operation) => mounted.current
    && sessionRef.current.operation?.id === operation.id && !sessionRef.current.operation.cancelling
    && sessionRef.current.input === operation.input;
  const isCurrentResult = (operation: Operation, result: ProcessedResult) => isCurrentOperation(operation)
    && sessionRef.current.result === result && !sessionRef.current.fileLoading
    && sessionRef.current.settingsReady && !sessionRef.current.settingsOpen
    && resultReady(sessionRef.current);
  const checkExport = (operation: Operation, result: ProcessedResult) => {
    if (isCurrentResult(operation, result)) return true;
    if (isCurrentOperation(operation)) {
      commit({ ...sessionRef.current, status: '已取消导出' });
    }
    return false;
  };
  const beginWrite = (operation: Operation, result: ProcessedResult) => {
    if (!checkExport(operation, result)) return false;
    commit({ ...sessionRef.current, operation: { ...operation, writing: true } });
    return true;
  };
  const finishOperation = (operation: Operation) => {
    if (mounted.current && sessionRef.current.operation?.id === operation.id && !sessionRef.current.operation.cancelling) {
      if (operation.exporting) pendingExportFocus.current = operation;
      commit({ ...sessionRef.current, operation: null, progress: null });
    }
  };
  const operationError = (operation: Operation, error: unknown) => {
    if (isCurrentOperation(operation)) commit({ ...sessionRef.current,
      status: '错误：' + userError(error, operation.exporting && resultReady(sessionRef.current) ? 'export' : 'process'),
      retryExport: operation.options && resultReady(sessionRef.current) && sessionRef.current.result
        ? { result: sessionRef.current.result, options: operation.options } : null });
  };

  const runBackend = async (operation: Operation, action: string, payload: Record<string, unknown>) => {
    const request = { ...operation, backendId: `${operation.backendId}_${++requestSequence.current}` };
    commit({ ...sessionRef.current, backend: { operation: request, cancelling: false }, progress: null });
    try { return await window.electronAPI.processAction(action, payload, request.backendId); }
    catch (error) {
      if (mounted.current && String(error).includes('Cannot confirm backend termination')) {
        commit({ ...sessionRef.current, backendUnavailable: true });
      }
      throw error;
    }
    finally {
      const current = sessionRef.current;
      if (mounted.current && current.backend?.operation.id === operation.id && !current.backend.cancelling) {
        commit({ ...current, backend: null });
      }
    }
  };
  const cancelBackend = async () => {
    const current = sessionRef.current, backend = current.backend;
    if (!backend || backend.cancelling || current.operation?.writing) return;
    const operation = backend.operation;
    const ownsStatus = current.operation?.id === operation.id && current.input === operation.input;
    commit({ ...current, backend: { ...backend, cancelling: true },
      operation: current.operation?.id === operation.id ? { ...current.operation, cancelling: true } : current.operation,
      status: ownsStatus ? '正在取消，请稍候…' : current.status });
    let confirmed = false;
    try { confirmed = (await window.electronAPI.cancelAction(operation.backendId)).confirmed === true; }
    catch { /* Keep the backend unavailable when cancellation cannot be confirmed. */ }
    if (!mounted.current || sessionRef.current.backend?.operation.id !== operation.id) return;
    const latest = sessionRef.current;
    const stillOwnsStatus = latest.operation?.id === operation.id && latest.input === operation.input;
    commit({ ...latest, backend: null, backendUnavailable: !confirmed, progress: null,
      operation: latest.operation?.id === operation.id ? null : latest.operation,
      status: !confirmed ? '错误：尚未确认处理已停止，请重启应用后再试'
        : stillOwnsStatus ? '已取消，可以重新处理' : latest.status });
  };

  const exportResult = async (operation: Operation, result: ProcessedResult, options: ExportOptions) => {
    let source = result.path;
    if (options.format === 'png_zip') {
      const generated = await runBackend(operation, 'export', {
        file_path: result.path, format: 'png_zip', dpi: options.dpi,
      }) as { zip_path?: string };
      if (!checkExport(operation, result)) return;
      if (!generated.zip_path) throw new Error('没有生成导出文件，请重试');
      source = generated.zip_path;
    }
    if (!checkExport(operation, result)) return;
    const defaultName = exportName(result.input.fileName, options.format, keywordMaskCount(result.review) > 0);
    const savePath = await window.electronAPI.saveFile({ defaultPath: defaultName,
      filters: [{ name: options.format === 'pdf' ? 'PDF 文件' : 'ZIP 文件', extensions: [options.format === 'pdf' ? 'pdf' : 'zip'] }] });
    if (!checkExport(operation, result)) return;
    if (!savePath) { commit({ ...sessionRef.current, status: '' }); return; }
    // Only the final copy locks input; the native chooser and ZIP generation
    // are revocable. Main retains the exact target and real I/O barrier.
    if (!beginWrite(operation, result)) return;
    const copied = await window.electronAPI.copyFile(source, savePath);
    if (!copied.success) throw new Error('无法保存文件，请检查保存位置的权限和可用空间后重试');
    if (isCurrentResult(operation, result)) commit({ ...sessionRef.current,
      status: options.format === 'pdf' ? 'PDF 导出成功' : 'PNG ZIP 导出成功', saved: { path: savePath, result } });
  };
  const runTask = async (options: ExportOptions | null, confirmed: ExportDecision | null = null) => {
    const current = sessionRef.current;
    if (!options && resultReady(current)) { selectPreview(false); return; }
    const operation = beginOperation(options ? '正在准备文件…' : '正在处理…', options, confirmed);
    if (!operation) return;
    try {
      let result = current.result;
      if (!resultReady(current) || !result) {
        const settings = { ...operation.input.settings };
        if (settings.ocr_mode !== 'local') {
          const saved = await window.electronAPI.getSettings();
          if (!isCurrentOperation(operation)) return;
          const status = saved.credential_storage_status;
          if (status && credentialStorageBlocked(status)) throw new Error(CREDENTIAL_STORAGE_MESSAGES[status]);
          if (saved.ocr_mode !== settings.ocr_mode ||
              (settings.ocr_mode === 'paddle' && saved.paddle_api_url !== settings.paddle_api_url)) {
            throw new Error('识别设置已变更，请确认设置后再处理。');
          }
          if (settings.ocr_mode === 'paddle') {
            settings.paddle_token = saved.paddle_token;
          } else {
            settings.baidu_api_key = saved.baidu_api_key;
            settings.baidu_secret_key = saved.baidu_secret_key;
          }
        }
        const response = await runBackend(operation, 'desensitize', {
          file_path: operation.input.filePath, keywords: [...operation.input.keywords], settings,
        }) as { output_path: string; warnings?: DesensitizationWarning[]; sanitization?: SanitizationSummary; review?: unknown };
        if (!isCurrentOperation(operation)) return;
        if (!response.output_path) throw new Error('没有生成处理结果，请重试');
        const review = parseReviewReport(response.review);
        if (!review) throw new Error('无法读取遮盖位置，请重新处理');
        if (response.warnings !== undefined && (!Array.isArray(response.warnings) || response.warnings.some(warning => !warning || typeof warning !== 'object'))) {
          throw new Error('没有生成有效处理结果，请重试');
        }
        result = { input: operation.input, path: response.output_path, warnings: [...(response.warnings ?? [])],
          sanitization: response.sanitization, review };
        commit({ ...sessionRef.current, result, previewError: null, status: '' });
        if (options && needsExportDecision(review, result.warnings)) {
          commit({ ...sessionRef.current, pendingExport: { result, options } });
          return;
        }
      }
      if (!isCurrentResult(operation, result)) return;
      if (options) await exportResult(operation, result, options);
      else commit({ ...sessionRef.current, status: '' });
    } catch (error) { operationError(operation, error); }
    finally { finishOperation(operation); }
  };
  const openExportDialog = () => {
    const current = sessionRef.current;
    if (current.operation || current.backend || current.backendUnavailable || current.fileLoading || !current.settingsReady || current.settingsOpen || current.exportDialog ||
        !current.input.filePath || !current.input.keywords.length) return;
    if (exportMenuRef.current) exportMenuRef.current.open = false;
    exportButtonRef.current?.focus();
    commit({ ...current, retryExport: null, exportDialog: { input: current.input, result: current.result } });
  };
  const closeExportDialog = (target: ExportDraft) => {
    if (sessionRef.current.exportDialog === target) commit({ ...sessionRef.current, exportDialog: null });
  };
  const confirmExport = (target: ExportDraft, options: ExportOptions) => {
    const current = sessionRef.current;
    if (current.exportDialog !== target) return;
    closeExportDialog(target);
    if (current.input !== target.input || current.result !== target.result) return;
    void runTask(options);
  };
  const continueExport = (target: ExportDecision) => {
    const current = sessionRef.current;
    if (!target.options || current.pendingExport !== target || current.result !== target.result || !resultReady(current)) return;
    void runTask(target.options, target);
  };

  const { filePath, fileName, keywords, settings: currentSettings } = session.input;
  const { status, settingsOpen: showSettings } = session;
  const isProcessing = !!session.operation || !!session.backend;
  const inputsLocked = !!session.operation?.writing;
  const desensitizedPath = session.result?.path;
  const warnings = session.result?.warnings ?? [];
  const showingOriginal = !!session.result && previewSelection?.result === session.result && previewSelection.original;
  const visiblePath = showingOriginal ? filePath : desensitizedPath ?? filePath;
  const activeLocation = !showingOriginal && session.result && previewLocation?.result === session.result ? previewLocation : null;
  const previewPage = (page: number, regionId?: string) => {
    const current = sessionRef.current;
    const result = current.result;
    if (!result || result.input !== current.input || current.operation?.writing || current.fileLoading ||
        !current.settingsReady || current.settingsOpen || !Number.isSafeInteger(page) || page <= 0) return;
    previewSelectionRef.current = { result, original: false };
    setPreviewSelection(previewSelectionRef.current);
    setPreviewLocation(previous => ({ result, page, regionId, sequence: (previous?.sequence ?? 0) + 1 }));
  };
  const selectPreview = (original: boolean) => {
    const current = sessionRef.current;
    if (current.result && current.result.input === current.input && !current.operation?.writing) {
      previewSelectionRef.current = { result: current.result, original };
      setPreviewSelection(previewSelectionRef.current);
    }
  };
  const selectedRegion = session.result?.review.regions.find(region => region.id === activeLocation?.regionId) ?? null;
  const pageRendered = (result: ProcessedResult, _page: number, pageCount: number) => {
    const current = sessionRef.current;
    if (current.result !== result || result.input !== current.input || current.operation?.writing ||
        current.fileLoading || !current.settingsReady || current.settingsOpen ||
        (previewSelectionRef.current?.result === result && previewSelectionRef.current.original)) return;
    if (!Number.isSafeInteger(pageCount) || result.review.pageCount !== pageCount) {
      commit({ ...current, result: null, pendingExport: null, retryExport: null, exportDialog: null, operation: null,
        saved: null, status: '错误：预览页数与处理报告不一致，请重新处理' });
    } else if (current.previewError === result) commit({ ...current, previewError: null });
  };
  const previewFailed = (result: ProcessedResult) => {
    const current = sessionRef.current;
    if (current.result !== result || result.input !== current.input || current.operation?.writing ||
        (previewSelectionRef.current?.result === result && previewSelectionRef.current.original) || current.previewError === result) return;
    commit({ ...current, previewError: result });
  };
  const inputsLoaded = session.settingsReady && !session.fileLoading && !showSettings;
  const inputsReady = inputsLoaded && !session.exportDialog;
  const canRun = !!filePath && keywords.length > 0 && !isProcessing && !session.backendUnavailable && inputsLoaded;
  const isError = status.startsWith('错误');
  const statusClass = isError ? 'status-error' : session.saved ? 'status-success' : 'status-info';
  const scopeLabels = { strict: '严格', normal: '常规', loose: '常规', line: '整行', paragraph: '整段 / 文本块' };
  const exportTarget = session.exportDialog;
  const currentResult = session.result;
  const noMatches = !!currentResult && keywordMaskCount(currentResult.review) === 0;
  const pending = session.pendingExport?.result === currentResult ? session.pendingExport : null;
  const progress = session.progress;
  const measured = progress && Number.isSafeInteger(progress.completed) && Number.isSafeInteger(progress.total) &&
    (progress.total ?? 0) > 0 && (progress.completed ?? -1) >= 0 && (progress.completed ?? 0) <= (progress.total ?? 0);
  const setMotionPreference = (value: MotionPreference) => { writeMotionPreference(value); setMotion(value); };
  const revealSaved = async () => {
    const saved = sessionRef.current.saved;
    if (!saved || sessionRef.current.result !== saved.result) return;
    try {
      if (!(await window.electronAPI.revealLastExport()).success) throw new Error('Cannot reveal export');
    } catch {
      if (sessionRef.current.saved === saved) commit({ ...sessionRef.current, status: '文件已保存，但无法打开文件位置。' });
    }
  };


  return (
    <div className="app" data-motion={motion}>
      <a className="skip-link" href="#document-panel">跳到文档预览</a>
      <header className="topbar">
        <div className="topbar-left"><h1 className="app-title">{pkg.branding.nameZh}</h1>
          <span className="ocr-badge">{OCR_MODE_LABELS[currentSettings.ocr_mode] ?? currentSettings.ocr_mode}</span>
        </div>
        <div className="topbar-actions">
          <button className="settings-btn" onClick={openSettings} disabled={inputsLocked}><SettingsIcon />设置</button>
          <div className="export-actions">
            <button ref={exportButtonRef} data-testid="open-export-button" className="btn-primary" disabled={!canRun}
              onClick={() => { void runTask({ format: 'pdf' }); }}>
              {isProcessing ? '正在处理…' : noMatches ? '另存为副本' : '导出 PDF'}
            </button>
            <details className="export-menu" ref={exportMenuRef}>
              <summary aria-label="其他导出格式" aria-disabled={!canRun} onClick={event => { if (!canRun) event.preventDefault(); }}>⌄</summary>
              <div className="export-menu-content"><button data-testid="open-image-export-button" disabled={!canRun} onClick={openExportDialog}>导出为图片…</button></div>
            </details>
          </div>
        </div>
      </header>
      <div className="main">
        <aside className="sidebar" aria-label="文件与打码内容">
          <div className="sidebar-scroll">
            <section className="sidebar-section file-section">
              <button type="button" data-testid="upload-zone" disabled={inputsLocked}
                aria-label={fileName ? '更换 PDF 文件' : '选择 PDF 文件'}
                className={`upload-zone${isDragOver ? ' drag-over' : ''}${fileName ? ' has-file' : ''}`}
                onClick={handleSelectFile} onDrop={handleDrop}
                onDragOver={event => { event.preventDefault(); if (!inputsLocked) setIsDragOver(true); }}
                onDragLeave={() => setIsDragOver(false)}>
                <FileIcon />
                {fileName ? <span className="upload-file"><span data-testid="file-name">{fileName}</span><span className="upload-hint">更换 PDF</span></span>
                  : <span>选择 PDF<span className="upload-hint">或拖到这里</span></span>}
              </button>
            </section>
            <section className="sidebar-section">
              <div className="section-heading"><label htmlFor="keyword-input" className="section-label">要打码的文字</label><span className="item-count">{keywords.length} 项</span></div>
              <textarea id="keyword-input" ref={inputRef} data-testid="keyword-input" className="keyword-input" rows={6}
                value={keywordText} disabled={inputsLocked} onChange={event => editKeywords(event.target.value)}
                aria-describedby="keyword-help" placeholder={'张三\n13900000000'} />
              <p id="keyword-help" className="muted-text">每行一项</p>
              <div className="keyword-actions">{!!keywords.length && <button className="clear-all-btn" onClick={clearKeywords} disabled={inputsLocked}>清空全部</button>}</div>
              <button data-testid="desensitize-button" className="btn-secondary" onClick={() => { void runTask(null); }} disabled={!canRun}>
                {currentResult ? '查看打码效果' : '预览打码效果'}
              </button>
            </section>
            <details className="sidebar-section rule-details">
              <summary>识别与打码设置</summary>
              <dl className="rule-summary">
                <div><dt>识别方式</dt><dd>{OCR_MODE_LABELS[currentSettings.ocr_mode]}</dd></div>
                <div><dt>匹配方式</dt><dd>{currentSettings.fuzzy_match_enabled ? '精确及近似匹配' : '精确匹配'}</dd></div>
                <div><dt>打码范围</dt><dd>{scopeLabels[currentSettings.redaction_scope]}</dd></div>
              </dl>
              <p className="muted-text">{currentSettings.ocr_mode === 'local' ? '文档在本机处理。' : currentSettings.ocr_mode === 'paddle' ? '文档将上传至配置的 PaddleOCR 服务。' : '页面图像将上传至百度 OCR。'}</p>
              <button className="btn-link-inline" onClick={openSettings} disabled={inputsLocked}>修改设置</button>
            </details>
            {currentResult && <ReviewRegions key={currentResult.path} report={currentResult.review} keywords={keywords}
              selected={activeLocation?.regionId} disabled={inputsLocked || !inputsReady} onLocate={previewPage} />}
            <details className="sidebar-section output-details" data-testid={currentResult?.sanitization?.policy === 'visible-page-content' ? 'sanitization-summary' : undefined}>
              <summary>导出内容</summary>
              <p className="muted-text">文件属性、附件和书签将移除。表单和批注不能再编辑，链接不能点击。</p>
              {currentResult?.sanitization?.policy === 'visible-page-content' && <p className="muted-text">
                已处理 {currentResult.sanitization.form_fields} 个表单项、{currentResult.sanitization.annotations} 条批注。</p>}
            </details>
          </div>
        </aside>
        <main id="document-panel" className="preview" tabIndex={-1} aria-label="文档预览">
          <div className="preview-toolbar">
            <h2 className="sr-only">{desensitizedPath && !showingOriginal ? '打码结果' : '原件'}</h2>
            <div className="preview-switch" aria-label="预览文件">
              <button type="button" aria-pressed={!currentResult || showingOriginal} disabled={!filePath || inputsLocked} onClick={() => selectPreview(true)}>原件</button>
              <button type="button" aria-pressed={!!currentResult && !showingOriginal} disabled={!currentResult || inputsLocked} onClick={() => selectPreview(false)}>打码结果</button>
            </div>
          </div>
          <div data-testid="status-bar" className={`status-bar ${statusClass}${status ? '' : ' empty-status'}`} role="status" aria-live="polite" aria-atomic="true">
            {status && <span>{status}</span>}
            {isProcessing && <div className="progress-track" role="progressbar" aria-label="处理进度" aria-valuemin={0}
              aria-valuemax={measured ? progress?.total : undefined} aria-valuenow={measured ? progress?.completed : undefined}>
              <span className={measured ? 'progress-measured' : 'progress-indeterminate'}
                style={measured ? { transform: `scaleX(${(progress?.completed ?? 0) / (progress?.total ?? 1)})` } : undefined} />
            </div>}
            {session.backend && !inputsLocked && <button data-testid="cancel-processing-button" className="btn-inline"
              onClick={() => { void cancelBackend(); }} disabled={session.backend.cancelling}>{session.backend.cancelling ? '正在取消…' : '取消处理'}</button>}
            {session.retryExport && session.retryExport.result === currentResult && <button className="btn-inline" disabled={!canRun}
              onClick={() => { const retry = sessionRef.current.retryExport; if (retry?.result === sessionRef.current.result) void runTask(retry.options); }}>重新保存</button>}
            {session.saved && session.saved.result === currentResult && <span className="saved-file">{session.saved.path.split(/[\\/]/).pop()}</span>}
            {session.saved && session.saved.result === currentResult && <button className="btn-inline" disabled={isProcessing || inputsLocked}
              onClick={() => { void revealSaved(); }}>打开文件位置</button>}
          </div>
          {currentResult && <ProcessingWarnings warnings={warnings} onPreviewPage={previewPage} disabled={inputsLocked || !inputsReady} />}
          {pending?.options && <div className="pending-export" role="alert">
            {noMatches && <p>没有找到这些文字，原文仍会保留。</p>}
            <button className="btn-secondary" disabled={!canRun} onClick={() => continueExport(pending)}>
              {noMatches ? '另存为副本' : pending.options.format === 'pdf' ? '仍然导出 PDF' : '仍然导出图片'}
            </button>
          </div>}
          {session.previewError === currentResult && currentResult && <p className="preview-notice">文件已生成，可先导出查看。</p>}
          {visiblePath ? <PdfPreview key={`${visiblePath}:${session.input.version}`} filePath={visiblePath} location={activeLocation}
            disabled={inputsLocked} region={showingOriginal ? null : selectedRegion}
            onPageRendered={!showingOriginal && currentResult ? (page, count) => pageRendered(currentResult, page, count) : undefined}
            onPreviewError={!showingOriginal && currentResult ? () => previewFailed(currentResult) : undefined} />
            : <div className="preview-empty"><FileIcon /><h2>选择要打码的 PDF</h2></div>}
        </main>
      </div>
      {showSettings && <SettingsModal motionPreference={motion} onMotionPreferenceChange={setMotionPreference} onClose={credentialsEdited => { void refreshSettings(credentialsEdited); }} />}
      {exportTarget && exportTarget.input === session.input && exportTarget.result === session.result &&
        <ExportDialog fileName={exportTarget.input.fileName ?? '文档.pdf'} defaultDpi={exportTarget.input.settings.export_dpi}
          onClose={() => closeExportDialog(exportTarget)} onConfirm={options => confirmExport(exportTarget, options)} />}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
