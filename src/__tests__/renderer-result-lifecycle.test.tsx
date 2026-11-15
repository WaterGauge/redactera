import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '../types/settings';

const capture = vi.hoisted(() => ({ element: null as React.ReactElement | null }));
vi.mock('react-dom/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-dom/client')>(),
  createRoot: vi.fn(() => ({ render: (element: React.ReactElement) => { capture.element = element; } })),
}));
vi.mock('../index.css', () => ({}));
// State-machine tests isolate PDF rasterization. The actual preview component
// has separate asynchronous rendering tests and an offline Electron check.
const previewEvents = vi.hoisted(() => ({ automatic: true, render: null as null | ((page: number, count: number, id?: string) => void), error: null as null | (() => void) }));
vi.mock('../components/PdfPreview', () => ({ PdfPreview: (props: {
  filePath: string; location: { page: number; sequence: number } | null;
  region?: { id: string; page: number } | null;
  onPageRendered?: (page: number, count: number, id?: string) => void; onPreviewError?: () => void;
}) => {
  previewEvents.render = props.onPageRendered ?? null; previewEvents.error = props.onPreviewError ?? null;
  const callback = React.useRef(props.onPageRendered); callback.current = props.onPageRendered;
  React.useEffect(() => { if (previewEvents.automatic) callback.current?.(props.location?.page ?? 1, 2, props.region?.id); }, [props.filePath, props.location?.page, props.location?.sequence, props.region?.id]);
  return <iframe key={`${props.filePath}:${props.location?.sequence ?? 0}`} title="PDF 预览" src={`pdf-safe://${encodeURIComponent(props.filePath)}${props.location ? `#page=${props.location.page}` : ''}`} />;
}}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const warning = { keyword: 'SECRET', page: 1, lines: ['SECRET'], message: 'synthetic warning' };
const output = { output_path: '/generated/A-redacted.pdf', warnings: [warning], review: {
  version: 1, pageCount: 2, regions: [
    { id: 'r1', page: 1, origin: 'keyword', keywords: ['SECRET'], polygon: [[.1,.1],[.2,.1],[.2,.2],[.1,.2]] },
    { id: 'r2', page: 2, origin: 'keyword', keywords: ['SECRET'], polygon: [[.1,.1],[.2,.1],[.2,.2],[.1,.2]] },
  ],
} };

describe('CR-015 warning meaning and preview location through the real App', () => {
  const typed = (type: string, page: number | null = 2) => ({
    type, page, keyword: 'SECRET', lines: ['opaque-line-id'],
    message: `${type} readable explanation`, reason: `${type} reason`,
    suggestedAction: `${type} next action`, affectedRegions: [{ kind: 'line', text: 'actual readable text' }],
  });

  it.each([
    ['cross_line', '跨行匹配'], ['coarse_location', '遮盖范围较大'],
    ['low_confidence', '文字可能识别不准'], ['no_match', '未找到“SECRET”'],
  ])('keeps the %s meaning, backend explanation and suggested action', async (type, label) => {
    const item = typed(type, type === 'no_match' ? null : 2);
    api.processAction.mockResolvedValueOnce({ ...output, warnings: [item] });
    await processed();
    const panel = within(screen.getByTestId('processing-warnings'));
    expect(panel.getByText(label)).toBeInTheDocument();
    expect(panel.getByText(item.message)).toBeInTheDocument();
    expect(panel.getByText(item.reason)).toBeInTheDocument();
    expect(panel.getByText(item.suggestedAction)).toBeInTheDocument();
    expect(panel.getByText('actual readable text')).toBeInTheDocument();
    expect(panel.queryByText('opaque-line-id')).not.toBeInTheDocument();
    expect(panel.queryByText(/建议拆分/)).not.toBeInTheDocument();
    expect(screen.getByTestId('processing-warnings')).toBeInTheDocument();
    expect(status()).not.toContain('跨行警告');
  });

  it('keeps legacy and future explanations without guessing a cross-line type', async () => {
    api.processAction.mockResolvedValueOnce({ ...output, warnings: [
      { keyword: 'SECRET', page: 1, lines: ['internal-777'], message: 'Legacy coarse detail' },
      { ...typed('future_type'), message: 'Future warning detail' },
    ] });
    await processed();
    const panel = within(screen.getByTestId('processing-warnings'));
    expect(panel.getAllByText('处理提示')).toHaveLength(2);
    expect(panel.getByText('Legacy coarse detail')).toBeInTheDocument();
    expect(panel.getByText('Future warning detail')).toBeInTheDocument();
    expect(panel.queryByText('internal-777')).not.toBeInTheDocument();
    expect(panel.queryByText(/跨行警告|建议拆分/)).not.toBeInTheDocument();
  });

  it.each([null, 0, -1, 1.5])('does not invent a page for document-wide or invalid page %s', async page => {
    api.processAction.mockResolvedValueOnce({ ...output, warnings: [typed('no_match', page)] });
    await processed();
    expect(within(screen.getByTestId('processing-warnings')).queryByRole('button')).not.toBeInTheDocument();
    expect(preview()).not.toContain('#page=');
  });

  it('remounts the authorized preview at the requested page, including repeat navigation', async () => {
    api.processAction.mockResolvedValueOnce({ ...output, warnings: [typed('cross_line')] });
    await processed();
    const first = screen.getByTitle('PDF 预览');
    fireEvent.click(screen.getByRole('button', { name: '查看第 2 页' }));
    expect(preview()).toBe('pdf-safe://%2Fgenerated%2FA-redacted.pdf#page=2');
    const second = screen.getByTitle('PDF 预览');
    expect(second).not.toBe(first);
    fireEvent.click(screen.getByRole('button', { name: '查看第 2 页' }));
    expect(screen.getByTitle('PDF 预览')).not.toBe(second);
    await prepareExport('pdf');
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.copyFile).toHaveBeenCalledWith(output.output_path, '/exports/result.pdf');
  });

  it('drops page location and warnings with the result when input changes', async () => {
    api.processAction.mockResolvedValueOnce({ ...output, warnings: [typed('cross_line')] });
    await processed();
    fireEvent.click(screen.getByRole('button', { name: '查看第 2 页' }));
    add('NEW');
    noResult();
    expect(preview()).toBe('pdf-safe://%2Ffixtures%2FA.pdf');
    await act(async () => { fireEvent.click(start()); });
    expect(preview()).toBe('pdf-safe://%2Fgenerated%2FA-redacted.pdf');
  });

  it('locks preview page changes while the final file is physically writing', async () => {
    api.processAction.mockResolvedValueOnce({ ...output, warnings: [typed('cross_line')] });
    await processed();
    const write = deferred<{ success: boolean }>(); api.copyFile.mockReturnValueOnce(write.promise);
    await prepareExport('pdf');
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(screen.getByRole('button', { name: '查看第 2 页' })).toBeDisabled();
    await act(async () => { write.resolve({ success: true }); });
    expect(screen.getByRole('button', { name: '查看第 2 页' })).toBeEnabled();
  });
});

function makeAPI() {
  const api = {
    openFile: vi.fn().mockResolvedValue(['/fixtures/A.pdf']),
    saveFile: vi.fn().mockResolvedValue('/exports/result.pdf'),
    processAction: vi.fn<Window['electronAPI']['processAction']>().mockImplementation(async (action, payload) =>
      action === 'desensitize' ? output : payload.format === 'png_zip' ? { zip_path: '/generated/pages.zip' } : {}),
    importDroppedFile: vi.fn().mockResolvedValue('/fixtures/dropped.pdf'),
    copyFile: vi.fn().mockResolvedValue({ success: true }),
    revealLastExport: vi.fn().mockResolvedValue({ success: true }),
    getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS }),
    saveSettings: vi.fn<Window['electronAPI']['saveSettings']>().mockImplementation(async (settings) => {
      api.getSettings.mockResolvedValue({ ...settings });
      return { success: true };
    }),
    onPythonCrashed: vi.fn<Window['electronAPI']['onPythonCrashed']>(),
    onProcessingProgress: vi.fn<Window['electronAPI']['onProcessingProgress']>().mockReturnValue(vi.fn()),
    cancelAction: vi.fn<Window['electronAPI']['cancelAction']>().mockResolvedValue({ confirmed: true }),
    getDeveloperMode: vi.fn().mockResolvedValue({ enabled: false, logFolderPath: '' }),
    getAppVersion: vi.fn().mockResolvedValue('1.2.1-beta.3'),
    getChangelog: vi.fn().mockResolvedValue({ currentVersion: '1.2.1-beta.3', entries: [] }),
    setDeveloperMode: vi.fn().mockResolvedValue({ success: true }),
    selectLogFolder: vi.fn().mockResolvedValue({ success: false }),
    validateBaidu: vi.fn().mockResolvedValue({ valid: true }),
    checkForUpdates: vi.fn().mockResolvedValue({ updateAvailable: false }),
    openReleasePage: vi.fn().mockResolvedValue({ success: true }),
    openReleasesPage: vi.fn().mockResolvedValue({ success: true }),
    readFileAsBase64: vi.fn(), readPdfPreview: vi.fn(),
  };
  return api;
}

describe('credential loading follows the OCR operation', () => {
  it('starts and processes locally using only non-credential settings', async () => {
    await ready();
    await act(async () => { fireEvent.click(start()); });
    expect(api.getSettings.mock.calls).toEqual([[false]]);
    expect(api.processAction).toHaveBeenCalledWith('desensitize', expect.objectContaining({
      settings: expect.objectContaining({ ocr_mode: 'local' }),
    }), expect.any(String));
  });

  it.each(['paddle', 'baidu'] as const)('loads only the selected %s credentials at processing time', async ocr_mode => {
    const preferences = { ...DEFAULT_SETTINGS, ocr_mode, paddle_api_url: 'https://example.invalid/ocr' };
    const saved = { ...preferences, paddle_token: 'synthetic-paddle',
      baidu_api_key: 'synthetic-baidu-key', baidu_secret_key: 'synthetic-baidu-secret' };
    api.getSettings.mockImplementation(async (includeCredentials?: boolean) =>
      includeCredentials === false ? preferences : saved);
    await ready();
    expect(api.getSettings.mock.calls).toEqual([[false]]);
    await act(async () => { fireEvent.click(start()); });
    expect(api.getSettings.mock.calls).toEqual([[false], []]);
    expect(api.processAction).toHaveBeenCalledWith('desensitize', expect.objectContaining({
      settings: expect.objectContaining({
        ocr_mode,
        paddle_token: ocr_mode === 'paddle' ? saved.paddle_token : '',
        baidu_api_key: ocr_mode === 'baidu' ? saved.baidu_api_key : '',
        baidu_secret_key: ocr_mode === 'baidu' ? saved.baidu_secret_key : '',
      }),
    }), expect.any(String));
  });

  it('keeps processing local to the app when saved cloud credentials cannot be unlocked', async () => {
    const preferences = { ...DEFAULT_SETTINGS, ocr_mode: 'paddle' as const };
    api.getSettings.mockImplementation(async (includeCredentials?: boolean) =>
      includeCredentials === false ? preferences : { ...preferences, credential_storage_status: 'locked' });
    await ready();
    await act(async () => { fireEvent.click(start()); });
    expect(api.processAction.mock.calls.some(([action]) => action === 'desensitize')).toBe(false);
    expect(status()).toContain('已保存的凭证未载入');
  });
});

describe('CR-016 progress and cancellation through the real App', () => {
  const work = async () => {
    const pending = deferred<typeof output>(); api.processAction.mockReturnValueOnce(pending.promise);
    await ready(); await act(async () => { fireEvent.click(start()); });
    return { pending, id: api.processAction.mock.calls[0][2] as string };
  };
  const progress = (id: string, message: string) => {
    act(() => { api.onProcessingProgress.mock.calls[0][0]({ operationId: id, stage: 'ocr', message, elapsedMs: 100 }); });
  };
  it('shows progress only for the current operation and keeps waiting for its terminal', async () => {
    const h = await work(); expect(h.id).toEqual(expect.any(String));
    progress('old-operation', 'stale'); expect(status()).not.toContain('stale');
    progress(h.id, '识别第2页'); expect(status()).toContain('识别第2页'); expect(start()).toBeDisabled(); noResult();
    await act(async () => { h.pending.resolve(output); }); expect(screen.getByRole('region', { name: '打码结果' })).toBeInTheDocument();
  });
  it('waits for cancellation confirmation and discards a result arriving meanwhile', async () => {
    const h = await work(), cancel = deferred<{ confirmed: boolean }>(); api.cancelAction.mockReturnValueOnce(cancel.promise);
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-processing-button')); });
    expect(api.cancelAction).toHaveBeenCalledWith(h.id); expect(status()).toContain('正在取消');
    expect(start()).toBeDisabled(); expect(screen.getByTestId('cancel-processing-button')).toBeDisabled();
    await act(async () => { h.pending.resolve(output); }); noResult(); expect(start()).toBeDisabled();
    await act(async () => { cancel.resolve({ confirmed: true }); });
    expect(status()).toContain('已取消'); expect(start()).toBeEnabled(); noResult();
  });
  it('keeps a background operation occupied after inputs invalidate its result', async () => {
    const h = await work(); add('NEW'); expect(start()).toBeDisabled(); noResult();
    progress(h.id, 'old-page'); expect(status()).not.toContain('old-page');
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-processing-button')); });
    expect(start()).toBeEnabled(); expect(status()).not.toContain('old-page');
    await act(async () => { h.pending.resolve(output); }); noResult();
  });
  it('keeps the backend unavailable when cancellation cannot confirm termination', async () => {
    await work(); api.cancelAction.mockResolvedValueOnce({ confirmed: false });
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-processing-button')); });
    expect(start()).toBeDisabled(); expect(status()).toMatch(/无法确认|重启/); noResult();
  });
  it('does not let a cancelled operation progress or finally overwrite the next operation', async () => {
    const old = await work();
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-processing-button')); });
    const next = deferred<typeof output>(); api.processAction.mockReturnValueOnce(next.promise);
    await act(async () => { fireEvent.click(start()); }); const id = api.processAction.mock.calls[1][2] as string;
    progress(id, 'new-page'); progress(old.id, 'old-page');
    await act(async () => { old.pending.resolve(output); });
    expect(status()).toContain('new-page'); expect(start()).toBeDisabled(); noResult();
    await act(async () => { next.resolve(output); }); expect(screen.getByRole('region', { name: '打码结果' })).toBeInTheDocument();
  });
  it('cancels ZIP generation without opening a save dialog or copying a partial output', async () => {
    await processed(); const zip = deferred<{ zip_path: string }>(); api.processAction.mockReturnValueOnce(zip.promise);
    await prepareExport('png');
    await act(async () => { fireEvent.click(screen.getByTestId('export-png-button')); });
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-processing-button')); });
    await act(async () => { zip.resolve({ zip_path: '/generated/late.zip' }); });
    expect(api.saveFile).not.toHaveBeenCalled(); expect(api.copyFile).not.toHaveBeenCalled();
    expect(screen.getByTestId('open-export-button')).toBeEnabled();
  });
  it('does not offer backend cancellation during actual final disk I/O', async () => {
    await processed(); const copy = deferred<{ success: boolean }>(); api.copyFile.mockReturnValueOnce(copy.promise);
    await prepareExport('pdf');
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(screen.queryByTestId('cancel-processing-button')).not.toBeInTheDocument();
    expect(start()).toBeDisabled(); await act(async () => { copy.resolve({ success: true }); });
    expect(status()).toContain('PDF 导出成功');
  });
  it('unsubscribes progress on unmount and ignores callbacks after unmount', async () => {
    await ready(); const unsubscribe = api.onProcessingProgress.mock.results[0].value;
    cleanup(); expect(unsubscribe).toHaveBeenCalledOnce();
    expect(() => progress('old', 'late')).not.toThrow();
  });
});

let api: ReturnType<typeof makeAPI>;
const start = () => screen.getByTestId('desensitize-button');
const status = () => screen.getByTestId('status-bar').textContent;
const preview = () => screen.getByTitle('PDF 预览').getAttribute('src');
const exportCalls = () => api.processAction.mock.calls.filter(([action]) => action === 'export');
const add = (word: string) => {
  const input = screen.getByTestId('keyword-input') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: [input.value, word].filter(Boolean).join('\n') } });
};
const noResult = () => {
  expect(screen.queryByRole('region', { name: '打码结果' })).not.toBeInTheDocument();
  expect(screen.queryByTestId('processing-warnings')).not.toBeInTheDocument();
};
async function mount() {
  const element = capture.element;
  if (!element) throw new Error('App bootstrap was not captured');
  await act(async () => { render(element); });
}
async function select(path = '/fixtures/A.pdf') {
  api.openFile.mockResolvedValueOnce([path]);
  await act(async () => { fireEvent.click(screen.getByTestId('upload-zone')); });
  expect(screen.getByTestId('file-name')).toHaveTextContent(path.split('/').pop() ?? path);
}
async function ready() {
  await mount(); await select(); add('SECRET');
}
async function prepareExport(format: string) {
  if (format === 'pdf') return;
  fireEvent.click(screen.getByLabelText('其他导出格式'));
  await act(async () => { fireEvent.click(screen.getByTestId('open-image-export-button')); });
}
async function processed() {
  await ready();
  await act(async () => { fireEvent.click(start()); });
  expect(screen.getByRole('region', { name: '打码结果' })).toBeInTheDocument();
}

describe('approved direct-export and optional-preview workflow', () => {
  it('processes and saves a normal PDF without any page-render callback or confirmation', async () => {
    previewEvents.automatic = false;
    api.processAction.mockResolvedValueOnce({ ...output, warnings: [] });
    await ready(); await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.saveFile).toHaveBeenCalledWith({ defaultPath: 'A_已打码.pdf', filters: [{ name: 'PDF 文件', extensions: ['pdf'] }] });
    expect(api.copyFile).toHaveBeenCalledWith(output.output_path, '/exports/result.pdf');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.processAction).toHaveBeenCalledTimes(1);
    expect(api.saveFile).toHaveBeenCalledTimes(2);
  });
  it('uses the complete multiline input, including an unsubmitted final line, without processing while typing', async () => {
    await mount();
    fireEvent.change(screen.getByTestId('keyword-input'), { target: { value: ' 张三，李四\nSECRET\n\nSECRET\n最终一项' } });
    fireEvent.keyDown(screen.getByTestId('keyword-input'), { key: 'Enter', isComposing: true });
    expect(api.processAction).not.toHaveBeenCalled();
    await select(); await act(async () => { fireEvent.click(start()); });
    expect(api.processAction.mock.calls[0][1].keywords).toEqual(['张三，李四', 'SECRET', '最终一项']);
  });
  it('collects new warnings into one decision and does not repeat it after the result has been seen', async () => {
    await ready(); await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.saveFile).not.toHaveBeenCalled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.saveFile).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '仍然导出 PDF' })); });
    expect(api.saveFile).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.processAction).toHaveBeenCalledTimes(1);
    expect(api.saveFile).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: '仍然导出 PDF' })).not.toBeInTheDocument();
  });
  it('keeps a result awaiting confirmation when the user switches to image export', async () => {
    await ready(); await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    await prepareExport('png');
    fireEvent.click(screen.getByRole('radio', { name: '200 DPI' }));
    await act(async () => { fireEvent.click(screen.getByTestId('export-png-button')); });
    expect(exportCalls()).toHaveLength(0);
    expect(api.saveFile).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '仍然导出图片' })); });
    expect(exportCalls()[0][1]).toEqual({ file_path: output.output_path, format: 'png_zip', dpi: 200 });
    expect(api.copyFile).toHaveBeenCalledOnce();
    expect(api.processAction.mock.calls.filter(([action]) => action === 'desensitize')).toHaveLength(1);
  });
  it.each(['file', 'settings'])('asks for confirmation again after a cancelled %s choice', async choice => {
    const exportButton = () => screen.getByTestId('open-export-button');
    const confirmButton = () => screen.queryByRole('button', { name: '仍然导出 PDF' });
    await ready(); await act(async () => { fireEvent.click(exportButton()); });
    expect(confirmButton()).toBeInTheDocument();

    if (choice === 'file') {
      api.openFile.mockResolvedValueOnce([]);
      await act(async () => { fireEvent.click(screen.getByTestId('upload-zone')); });
    } else {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
      await act(async () => { fireEvent.click(screen.getByText('取消')); });
    }
    expect(confirmButton()).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(exportButton()); });
    expect(confirmButton()).toBeInTheDocument();
    expect(api.saveFile).not.toHaveBeenCalled();
    expect(api.processAction).toHaveBeenCalledTimes(1);
  });
  it('allows a user who chose preview to export directly after seeing the warning', async () => {
    await processed();
    expect(screen.queryByRole('button', { name: '仍然导出 PDF' })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.copyFile).toHaveBeenCalledOnce();
  });
  it('does not interrupt export for an ordinary exact cross-line match', async () => {
    api.processAction.mockResolvedValueOnce({ ...output, warnings: [{ ...warning, type: 'cross_line' }] });
    await ready(); await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.copyFile).toHaveBeenCalledOnce();
  });
  it('makes a zero-match copy explicit, without treating original redactions as current matches', async () => {
    api.processAction.mockResolvedValueOnce({ ...output, review: { ...output.review, regions: [
      { ...output.review.regions[0], origin: 'existing', keywords: [] },
    ] }, warnings: [{ ...warning, type: 'no_match', page: null }] });
    await ready(); await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.saveFile).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '未找到要打码的文字' })).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '另存为副本' })); });
    expect(api.saveFile.mock.calls[0][0].defaultPath).toBe('A_副本.pdf');
    expect(api.copyFile).toHaveBeenCalledOnce();
  });
  it.each([undefined, { version: 2 }, { version: 1, pageCount: 0, regions: [] }])('refuses a missing or invalid position report: %s', async review => {
    api.processAction.mockResolvedValueOnce({ ...output, review });
    await ready(); await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    noResult(); expect(api.saveFile).not.toHaveBeenCalled(); expect(status()).toContain('错误');
  });
  it('permits saving a backend-validated result when only its display failed', async () => {
    await processed(); await act(async () => { previewEvents.error?.(); });
    expect(screen.getByText('文件已生成，可先导出查看。')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.copyFile).toHaveBeenCalledOnce();
  });
  it('abandons a waiting save when actual preview metadata contradicts the backend report', async () => {
    await processed(); const save = deferred<string | undefined>(); api.saveFile.mockReturnValueOnce(save.promise);
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    await act(async () => { previewEvents.render?.(1, 3); });
    await act(async () => { save.resolve('/exports/wrong.pdf'); });
    noResult(); expect(api.copyFile).not.toHaveBeenCalled(); expect(status()).toContain('页数');
  });
  it('ignores callbacks from the old result and from the original view', async () => {
    await processed(); const old = previewEvents.render;
    add('NEW'); await act(async () => { fireEvent.click(start()); });
    await act(async () => { old?.(1, 999); });
    expect(screen.getByRole('region', { name: '打码结果' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '原件' }));
    await act(async () => { old?.(1, 999); });
    expect(screen.getByTestId('open-export-button')).toBeEnabled();
  });
  it('cancels a pending warning decision when inputs are edited and restored', async () => {
    await ready(); await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    const oldButton = screen.getByRole('button', { name: '仍然导出 PDF' });
    add('NEW'); fireEvent.change(screen.getByTestId('keyword-input'), { target: { value: 'SECRET' } });
    fireEvent.click(oldButton);
    expect(api.saveFile).not.toHaveBeenCalled(); noResult();
  });
  it('applies motion only on settings save and reuses the same processing result', async () => {
    await processed();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
    fireEvent.change(screen.getByLabelText('动态效果'), { target: { value: 'off' } });
    await act(async () => { fireEvent.click(screen.getByText('取消')); });
    expect(document.querySelector('.app')).toHaveAttribute('data-motion', 'system');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
    fireEvent.change(screen.getByLabelText('动态效果'), { target: { value: 'off' } });
    await act(async () => { fireEvent.click(screen.getByText('保存')); });
    expect(document.querySelector('.app')).toHaveAttribute('data-motion', 'off');
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.processAction).toHaveBeenCalledTimes(1);
  });
});


it('restores export focus after React commits an enabled button even if a frame fires before that commit', async () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1; });
  await processed(); const save = deferred<string | undefined>(); api.saveFile.mockReturnValueOnce(save.promise);
  const opener = screen.getByTestId('open-export-button'); opener.focus(); await prepareExport('pdf');
  await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
  expect(opener).toBeDisabled();
  // Simulate the browser returning from a native panel after disabling its opener.
  document.body.tabIndex = -1; document.body.focus(); expect(document.body).toHaveFocus();
  await act(async () => { save.resolve(undefined); });
  expect(opener).toBeEnabled(); expect(opener).toHaveFocus();
});
async function closeSettings() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
  await act(async () => { fireEvent.click(screen.getByText('取消')); });
}
async function changeInput(kind: string) {
  if (kind === 'keyword') add('NEW');
  if (kind === 'file') await select('/fixtures/B.pdf');
  if (kind === 'settings') {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
    fireEvent.change(screen.getByLabelText('遮盖范围'), { target: { value: '3' } });
    await act(async () => { fireEvent.click(screen.getByText('保存')); });
  }
}
function drop(name = 'drop.pdf') {
  const file = new File(['%PDF-1.7\n%%EOF'], name, { type: 'application/pdf' });
  fireEvent.drop(screen.getByTestId('upload-zone'), { dataTransfer: { files: [file] } });
  return file;
}

it.each([150, 200, 300] as const)('exports PNG ZIP with the processed input DPI %s', async dpi => {
  api.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, export_dpi: dpi });
  await processed();
  await prepareExport('png');
  await act(async () => { fireEvent.click(screen.getByTestId('export-png-button')); });
  expect(exportCalls()[0]).toEqual(['export', { file_path: output.output_path, format: 'png_zip', dpi }, expect.any(String)]);
});

beforeAll(async () => { await import('../renderer'); });
beforeEach(() => {
  previewEvents.automatic = true; window.localStorage.clear();
  api = makeAPI();
  Object.assign(window, { electronAPI: api });
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('workbench keyboard semantics and visible input identity', () => {
  it('does not present applied pre-existing redaction annotations as current keyword hit counts', async () => {
    api.processAction.mockResolvedValueOnce({ ...output, sanitization: { policy: 'visible-page-content', form_fields: 0, annotations: 4, applied_redactions: 3 } });
    await processed();
    expect(screen.getByRole('heading', { name: '已打码 2 处' })).toBeInTheDocument();
    expect(screen.getByTestId('sanitization-summary')).toHaveTextContent('4 条批注');
  });
  it('uses a labelled native upload button and a labelled keyword field', async () => {
    await mount();
    expect(screen.getByRole('button', { name: '选择 PDF 文件' })).toBe(screen.getByTestId('upload-zone'));
    expect(screen.getByLabelText('要打码的文字')).toBe(screen.getByTestId('keyword-input'));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('bulk-adds one keyword per line, deduplicates without splitting punctuation, and invalidates a result', async () => {
    await processed();
    fireEvent.change(screen.getByLabelText('要打码的文字'), { target: { value: ' SECRET\n张三，李四\n\n张三，李四\n新词 ' } });
    noResult();
    expect(screen.getByText('3 项')).toBeInTheDocument();
    await act(async () => { fireEvent.click(start()); });
    expect(api.processAction.mock.calls.at(-1)?.[1].keywords).toEqual(['SECRET', '张三，李四', '新词']);
  });

  it('does not start work from IME composition and clears the complete input accessibly', async () => {
    await ready();
    const input = screen.getByLabelText('要打码的文字');
    fireEvent.change(input, { target: { value: '输入中' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(screen.queryByRole('button', { name: '删除文字：输入中' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '清空全部' }));
    expect(input).toHaveFocus();
    expect(start()).toBeDisabled();
  });

  it('labels original versus result without changing the export source, and warning navigation restores the result', async () => {
    await processed();
    fireEvent.click(screen.getByRole('button', { name: '原件' }));
    expect(preview()).toBe('pdf-safe://%2Ffixtures%2FA.pdf');
    expect(screen.getByRole('heading', { name: '原件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '原件' })).toHaveAttribute('aria-pressed', 'true');
    await prepareExport('pdf');
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.copyFile).toHaveBeenCalledWith(output.output_path, '/exports/result.pdf');
    fireEvent.click(screen.getByRole('button', { name: '查看第 1 页' }));
    expect(preview()).toBe('pdf-safe://%2Fgenerated%2FA-redacted.pdf#page=1');
    expect(screen.getByRole('button', { name: '打码结果' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('has a named modal, labelled controls and cancel-event dismissal back to its opener', async () => {
    await mount();
    const opener = screen.getByRole('button', { name: '设置' }); opener.focus();
    await act(async () => { fireEvent.click(opener); });
    const dialog = screen.getByRole('dialog', { name: '设置' });
    expect(screen.getByRole('button', { name: '关闭设置' })).toHaveFocus();
    expect(within(dialog).getByLabelText('识别语言（仅本地）')).toHaveAttribute('id', 'ocr-language');
    fireEvent.change(within(dialog).getByLabelText('识别图像分辨率（DPI）'), { target: { value: '300' } });
    await act(async () => { fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true })); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('does not allow Escape to dismiss settings while a save is pending', async () => {
    await mount();
    const saved = deferred<{ success: boolean }>(); api.saveSettings.mockReturnValueOnce(saved.promise);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
    const dialog = screen.getByRole('dialog', { name: '设置' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })); });
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭设置' })).toBeDisabled();
    await act(async () => { saved.resolve({ success: true }); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('CR-004 result lifecycle through the real App', () => {
  it('reuses valid PDF and ZIP results when only duplicate or blank input lines change', async () => {
    await processed();
    expect(preview()).toBe('pdf-safe://%2Fgenerated%2FA-redacted.pdf');
    add(' SECRET ');
    fireEvent.change(screen.getByTestId('keyword-input'), { target: { value: 'SECRET\n ' } });
    await prepareExport('pdf');
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.copyFile).toHaveBeenCalledWith(output.output_path, '/exports/result.pdf');
    await prepareExport('png');
    await act(async () => { fireEvent.click(screen.getByTestId('export-png-button')); });
    expect(api.copyFile).toHaveBeenCalledWith('/generated/pages.zip', '/exports/result.pdf');
    await prepareExport('pdf');
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(exportCalls()).toHaveLength(1);
    expect(api.copyFile).toHaveBeenCalledTimes(3);
  });

  it.each(['add', 'remove', 'clear'])('invalidates result, warning and preview after keyword %s', async (change) => {
    await processed();
    if (change === 'add') add('NEW');
    if (change === 'remove') fireEvent.change(screen.getByTestId('keyword-input'), { target: { value: '' } });
    if (change === 'clear') fireEvent.click(screen.getByText('清空全部'));
    noResult(); expect(preview()).toBe('pdf-safe://%2Ffixtures%2FA.pdf');
  });

  it('invalidates even when keywords are changed and then restored', async () => {
    await processed(); add('NEW'); fireEvent.change(screen.getByTestId('keyword-input'), { target: { value: 'SECRET' } });
    noResult();
  });

  it('invalidates after saving changed settings through the real SettingsModal', async () => {
    await processed();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
    fireEvent.change(screen.getByLabelText('遮盖范围'), { target: { value: '3' } });
    await act(async () => { fireEvent.click(screen.getByText('保存')); });
    noResult(); expect(preview()).toBe('pdf-safe://%2Ffixtures%2FA.pdf');
  });

  it('preserves valid results when settings are unchanged and file selection is cancelled', async () => {
    await processed(); await closeSettings();
    api.openFile.mockResolvedValueOnce([]);
    await act(async () => { fireEvent.click(screen.getByTestId('upload-zone')); });
    expect(screen.getByTestId('open-export-button')).toBeEnabled();
    expect(preview()).toBe('pdf-safe://%2Fgenerated%2FA-redacted.pdf');
  });

  it('withdraws the old result when retry starts, keeps it withdrawn on failure, and permits a later retry', async () => {
    await processed();
    const job = deferred<unknown>(); api.processAction.mockReturnValueOnce(job.promise);
    add('NEW'); fireEvent.click(start()); noResult();
    await act(async () => { job.reject(new Error('synthetic failure')); });
    noResult(); expect(status()).toContain('处理未完成');
    await act(async () => { fireEvent.click(start()); });
    expect(screen.getByTestId('open-export-button')).toBeEnabled();
  });

  it.each(['success', 'failure'])('ignores late A %s and finally while B is processing', async (outcome) => {
    await ready();
    const a = deferred<unknown>(), b = deferred<unknown>();
    api.processAction.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    fireEvent.click(start()); await select('/fixtures/B.pdf');
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-processing-button')); });
    fireEvent.click(start());
    await act(async () => { outcome === 'success' ? a.resolve(output) : a.reject(new Error('late A failure')); });
    noResult(); expect(status()).toContain('正在处理'); expect(start()).toBeDisabled();
    expect(preview()).toBe('pdf-safe://%2Ffixtures%2FB.pdf');
    await act(async () => { b.resolve({ ...output, output_path: '/generated/B.pdf', warnings: [] }); });
    expect(preview()).toBe('pdf-safe://%2Fgenerated%2FB.pdf');
  });

  it('treats selecting the same path again as a new file version', async () => {
    await ready(); const a = deferred<unknown>(); api.processAction.mockReturnValueOnce(a.promise);
    fireEvent.click(start()); await select();
    await act(async () => { a.resolve(output); }); noResult();
    expect(preview()).toBe('pdf-safe://%2Ffixtures%2FA.pdf');
  });

  it('shows actionable loader guidance and invalidates the result after a dependency failure', async () => {
    await processed();
    act(() => { api.onPythonCrashed.mock.calls[0][0]({ code: -1073741515 }); });
    noResult();
    expect(status()).toContain('Microsoft Visual C++ x64');
    expect(status()).not.toContain('-1073741515');
    expect(api.copyFile).not.toHaveBeenCalled();
  });

  it('revokes results and late responses when Python crashes', async () => {
    await processed(); const a = deferred<unknown>(); api.processAction.mockReturnValueOnce(a.promise);
    fireEvent.click(start());
    act(() => { api.onPythonCrashed.mock.calls[0][0]({ code: 1 }); });
    await act(async () => { a.resolve(output); }); noResult();
    expect(status()).not.toContain('处理完成');
  });

  it.each([
    ['pdf', 'keyword'], ['pdf', 'file'], ['pdf', 'settings'],
    ['png', 'keyword'], ['png', 'file'], ['png', 'settings'],
  ])('does not export or copy after the %s save dialog when %s changes', async (format, kind) => {
    await processed(); const dialog = deferred<string | undefined>(); api.saveFile.mockReturnValueOnce(dialog.promise);
    await prepareExport(format);
    await act(async () => { fireEvent.click(screen.getByTestId(format === 'pdf' ? 'open-export-button' : 'export-png-button')); });
    await changeInput(kind); await act(async () => { dialog.resolve('/exports/stale'); });
    expect(exportCalls().filter(([, payload]) => payload.format === 'pdf')).toHaveLength(0);
    expect(api.copyFile).not.toHaveBeenCalled(); noResult();
  });

  it('does not open a save dialog or copy when ZIP generation becomes stale', async () => {
    await processed(); const zip = deferred<unknown>(); api.processAction.mockReturnValueOnce(zip.promise);
    await prepareExport('png'); fireEvent.click(screen.getByTestId('export-png-button')); await select('/fixtures/B.pdf');
    await act(async () => { zip.resolve({ zip_path: '/generated/stale.zip' }); });
    expect(api.saveFile).not.toHaveBeenCalled(); expect(api.copyFile).not.toHaveBeenCalled(); noResult();
  });

  it.each(['pdf', 'png'])('keeps inputs locked during actual %s disk writing', async (format) => {
    await processed(); const write = deferred<unknown>();
    api.copyFile.mockReturnValueOnce(write.promise);
    await prepareExport(format);
    await act(async () => { fireEvent.click(screen.getByTestId(format === 'pdf' ? 'open-export-button' : 'export-png-button')); });
    expect(screen.getByTestId('keyword-input')).toBeDisabled();
    fireEvent.click(screen.getByTestId('upload-zone')); fireEvent.click(screen.getByText('清空全部'));
    expect(api.openFile).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('keyword-input')).toHaveValue('SECRET');
    await act(async () => { write.resolve({ success: true }); });
    expect(screen.getByTestId('keyword-input')).toBeEnabled();
    expect(screen.getByTestId('open-export-button')).toBeEnabled();
  });

  it.each(['pdf', 'png'])('releases busy and preserves a valid result after cancelling %s export', async (format) => {
    await processed(); api.saveFile.mockResolvedValueOnce(undefined);
    await prepareExport(format);
    await act(async () => { fireEvent.click(screen.getByTestId(format === 'pdf' ? 'open-export-button' : 'export-png-button')); });
    expect(screen.getByTestId('open-export-button')).toBeEnabled();
    expect(api.copyFile).not.toHaveBeenCalled();
  });

  it('takes only one export request from same-batch double clicks', async () => {
    await processed(); const dialog = deferred<string | undefined>(); api.saveFile.mockReturnValue(dialog.promise);
    await prepareExport('pdf');
    act(() => { const button = screen.getByTestId('open-export-button'); button.click(); button.click(); });
    expect(api.saveFile).toHaveBeenCalledTimes(1);
    await act(async () => { dialog.resolve(undefined); });
  });

  it('ignores an older file chooser response after a newer selection', async () => {
    await ready(); const first = deferred<string[]>(); api.openFile.mockReturnValueOnce(first.promise);
    fireEvent.click(screen.getByTestId('upload-zone')); await select('/fixtures/B.pdf');
    await act(async () => { first.resolve(['/fixtures/C-stale.pdf']); });
    expect(screen.getByTestId('file-name')).toHaveTextContent('B.pdf');
  });

  it('passes a File directly and ignores its stale import response after a newer selection', async () => {
    await ready();
    const saved = deferred<string>();
    api.importDroppedFile.mockReturnValueOnce(saved.promise);
    const file = drop();
    expect(api.importDroppedFile).toHaveBeenCalledTimes(1);
    expect(api.importDroppedFile.mock.calls[0][0] === file).toBe(true);
    await select('/fixtures/B.pdf');
    await act(async () => { saved.resolve('/fixtures/stale.pdf'); });
    expect(screen.getByTestId('file-name')).toHaveTextContent('B.pdf');
  });

  it('waits for a pending file import before dispatching a disk export', async () => {
    await processed(); const saved = deferred<string>();
    api.importDroppedFile.mockReturnValueOnce(saved.promise);
    act(() => { drop(); });
    fireEvent.click(screen.getByTestId('open-export-button'));
    expect(api.saveFile).not.toHaveBeenCalled(); expect(exportCalls()).toHaveLength(0);
    await act(async () => { saved.resolve('/fixtures/drop.pdf'); }); noResult();
  });

  it('does not use default settings while initial settings are pending or apply a superseded settings read', async () => {
    const initial = deferred<typeof DEFAULT_SETTINGS>(); api.getSettings.mockReturnValueOnce(initial.promise);
    await mount(); await select(); add('SECRET'); expect(start()).toBeDisabled();
    api.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, ocr_mode: 'baidu' });
    await closeSettings();
    await act(async () => { initial.resolve({ ...DEFAULT_SETTINGS }); });
    await act(async () => { fireEvent.click(start()); });
    expect(api.processAction).toHaveBeenCalledWith('desensitize', expect.objectContaining({
      settings: expect.objectContaining({ ocr_mode: 'baidu' }),
    }), expect.any(String));
  });

  it('blocks export until settings refresh after closing the modal completes', async () => {
    await processed();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
    const settings = deferred<typeof DEFAULT_SETTINGS>(); api.getSettings.mockReturnValueOnce(settings.promise);
    fireEvent.click(screen.getByText('取消'));
    fireEvent.click(screen.getByTestId('open-export-button'));
    expect(api.saveFile).not.toHaveBeenCalled();
    await act(async () => { settings.resolve({ ...DEFAULT_SETTINGS, redaction_scope: 'paragraph' }); }); noResult();
  });

  it('keeps a pending settings save inside the modal so it cannot race an export', async () => {
    await processed();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
    const saved = deferred<{ success: boolean }>(); api.saveSettings.mockReturnValueOnce(saved.promise);
    fireEvent.click(screen.getByText('保存')); fireEvent.click(screen.getByText('取消'));
    expect(screen.getByText('取消')).toBeDisabled();
    fireEvent.click(screen.getByTestId('open-export-button'));
    expect(api.saveFile).not.toHaveBeenCalled();
    await act(async () => { saved.resolve({ success: true }); });
    await waitFor(() => expect(screen.queryByText('取消')).not.toBeInTheDocument());
  });

  it('does not accept A after B has completed, even when keywords return to their original values', async () => {
    await ready(); const a = deferred<unknown>(); api.processAction.mockReturnValueOnce(a.promise);
    fireEvent.click(start()); add('NEW'); fireEvent.change(screen.getByTestId('keyword-input'), { target: { value: 'SECRET' } });
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-processing-button')); });
    api.processAction.mockResolvedValueOnce({ ...output, output_path: '/generated/B.pdf', warnings: [] });
    await act(async () => { fireEvent.click(start()); });
    await act(async () => { a.resolve(output); });
    expect(preview()).toBe('pdf-safe://%2Fgenerated%2FB.pdf');
    expect(screen.queryByTestId('processing-warnings')).not.toBeInTheDocument();
    await prepareExport('pdf');
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(api.copyFile).toHaveBeenLastCalledWith('/generated/B.pdf', '/exports/result.pdf');
  });

  it.each(['pdf', 'png'])('ignores an old %s export error and finally while a new job runs', async (format) => {
    await processed(); const dialog = deferred<string | undefined>(); api.saveFile.mockReturnValueOnce(dialog.promise);
    await prepareExport(format);
    await act(async () => { fireEvent.click(screen.getByTestId(format === 'pdf' ? 'open-export-button' : 'export-png-button')); });
    await select('/fixtures/B.pdf');
    const b = deferred<unknown>(); api.processAction.mockReturnValueOnce(b.promise); fireEvent.click(start());
    await act(async () => { dialog.reject(new Error('old dialog failure')); });
    expect(start()).toBeDisabled(); expect(status()).toContain('正在处理');
    await act(async () => { b.resolve({ ...output, output_path: '/generated/B.pdf', warnings: [] }); });
    expect(preview()).toBe('pdf-safe://%2Fgenerated%2FB.pdf');
  });

  it.each(['pdf', 'png'])('does not unlock an in-flight %s disk copy when Python crashes', async (format) => {
    await processed(); const copy = deferred<unknown>(); api.copyFile.mockReturnValueOnce(copy.promise);
    await prepareExport(format);
    await act(async () => { fireEvent.click(screen.getByTestId(format === 'pdf' ? 'open-export-button' : 'export-png-button')); });
    act(() => { api.onPythonCrashed.mock.calls[0][0]({ code: 1 }); });
    noResult(); expect(screen.getByTestId('keyword-input')).toBeDisabled();
    await act(async () => { copy.resolve({ success: true }); });
    expect(screen.getByTestId('keyword-input')).toBeEnabled(); expect(status()).toContain('意外停止');
  });

  it('takes only one processing request from same-batch double clicks', async () => {
    await ready(); const job = deferred<unknown>(); api.processAction.mockReturnValue(job.promise);
    act(() => { const button = start(); button.click(); button.click(); });
    expect(api.processAction).toHaveBeenCalledTimes(1);
    await act(async () => { job.resolve(output); });
  });

  it('handles a failed settings refresh without exposing an old result and permits recovery', async () => {
    await processed();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
    api.getSettings.mockRejectedValueOnce(new Error('settings unavailable'));
    await act(async () => { fireEvent.click(screen.getByText('取消')); });
    noResult(); expect(start()).toBeDisabled(); expect(status()).toContain('无法读取设置');
    await closeSettings(); expect(start()).toBeEnabled();
  });

  it('keeps failed settings saves visible, releases the save lock and permits retry', async () => {
    await processed();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
    api.saveSettings.mockRejectedValueOnce(new Error('save failed'));
    await act(async () => { fireEvent.click(screen.getByText('保存')); });
    expect(screen.getByRole('alert')).toHaveTextContent('设置保存失败');
    expect(screen.getByText('取消')).toBeEnabled();
    await act(async () => { fireEvent.click(screen.getByText('保存')); });
    expect(screen.getByTestId('open-export-button')).toBeEnabled();
  });

  it('cancels export cleanly if a later file selection is pending, even when that selection is then cancelled', async () => {
    await processed(); const dialog = deferred<string | undefined>(), chooser = deferred<string[]>();
    api.saveFile.mockReturnValueOnce(dialog.promise); await prepareExport('pdf'); fireEvent.click(screen.getByTestId('open-export-button'));
    api.openFile.mockReturnValueOnce(chooser.promise); fireEvent.click(screen.getByTestId('upload-zone'));
    await act(async () => { dialog.resolve('/exports/stale.pdf'); });
    expect(exportCalls()).toHaveLength(0);
    await act(async () => { chooser.resolve([]); });
    expect(screen.getByTestId('open-export-button')).toBeEnabled();
    expect(status()).not.toContain('正在导出');
  });

  it('keeps PDF inputs locked beyond the Python request deadline until the main-process copy settles', async () => {
    await processed();
    const copy = deferred<unknown>(); api.copyFile.mockReturnValueOnce(copy.promise);
    api.processAction.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('Request timeout after 300000ms')), 300000);
    }));
    vi.useFakeTimers();
    try {
      await prepareExport('pdf');
      await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(300001); });
      expect(screen.getByTestId('keyword-input')).toBeDisabled();
      expect(exportCalls()).toHaveLength(0);
      expect(api.copyFile).toHaveBeenCalledWith(output.output_path, '/exports/result.pdf');
      await act(async () => { copy.resolve({ success: true }); });
      expect(screen.getByTestId('keyword-input')).toBeEnabled();
    } finally { vi.useRealTimers(); }
  });

  it('clears the abandoned ZIP-generation status after a pending file selection is cancelled', async () => {
    await processed(); const zip = deferred<unknown>(), chooser = deferred<string[]>();
    api.processAction.mockReturnValueOnce(zip.promise); await prepareExport('png'); fireEvent.click(screen.getByTestId('export-png-button'));
    api.openFile.mockReturnValueOnce(chooser.promise); fireEvent.click(screen.getByTestId('upload-zone'));
    await act(async () => { zip.resolve({ zip_path: '/generated/unused.zip' }); });
    expect(api.saveFile).not.toHaveBeenCalled();
    await act(async () => { chooser.resolve([]); });
    expect(status()).not.toContain('正在生成');
    expect(screen.getByTestId('open-export-button')).toBeEnabled();
  });

  it.each([
    ['pdf', 'reject'], ['png', 'reject'], ['pdf', 'false'], ['png', 'false'],
  ])('allows retry after %s copying reports %s failure', async (format, outcome) => {
    await processed();
    if (outcome === 'reject') api.copyFile.mockRejectedValueOnce(new Error('copy failed'));
    else api.copyFile.mockResolvedValueOnce({ success: false });
    await prepareExport(format);
    await act(async () => { fireEvent.click(screen.getByTestId(format === 'pdf' ? 'open-export-button' : 'export-png-button')); });
    expect(status()).toContain('错误');
    expect(screen.getByTestId('keyword-input')).toBeEnabled();
    expect(screen.getByTestId('open-export-button')).toBeEnabled();
    await prepareExport('pdf');
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(status()).toContain('PDF 导出成功');
  });

  it.each(['keyword', 'file', 'settings'])('shows the cleanup report only for the current result, including after %s changes', async (kind) => {
    await ready();
    api.processAction.mockResolvedValueOnce({ ...output, sanitization: {
      policy: 'visible-page-content', form_fields: 1, annotations: 2, applied_redactions: 0,
    } });
    await act(async () => { fireEvent.click(start()); });
    expect(screen.getByTestId('sanitization-summary')).toHaveTextContent('表单和批注不能再编辑');
    expect(screen.getByTestId('sanitization-summary')).toHaveTextContent('1 个表单项、2 条批注');
    await changeInput(kind);
    expect(screen.queryByTestId('sanitization-summary')).not.toBeInTheDocument();
  });
});


describe('export options bound to the current result', () => {
  it('opens one image-options dialog without dispatching, and Escape returns focus to the stable export action', async () => {
    await processed(); const opener = screen.getByTestId('open-export-button');
    await prepareExport('png');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(opener).toBeEnabled();
    const dialog = screen.getByRole('dialog', { name: '导出为图片' });
    expect(within(dialog).getByText('A.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭导出窗口' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: '150 DPI' })).toBeChecked();
    expect(exportCalls()).toHaveLength(0); expect(api.saveFile).not.toHaveBeenCalled();
    await act(async () => { fireEvent(dialog, new Event('cancel', { cancelable: true })); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(opener).toHaveFocus();
    expect(api.copyFile).not.toHaveBeenCalled();
  });

  it('cancels a PNG draft without changing settings and starts the next draft from the result default', async () => {
    await processed(); await prepareExport('png');
    fireEvent.click(screen.getByRole('radio', { name: '300 DPI' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(exportCalls()).toHaveLength(0); expect(api.saveSettings).not.toHaveBeenCalled();
    await prepareExport('png');
    expect(screen.getByRole('radio', { name: '150 DPI' })).toBeChecked();
    expect(api.processAction.mock.calls[0][1].settings).toEqual(expect.objectContaining({ export_dpi: 150 }));
  });

  it.each([150, 200, 300] as const)('exports the selected %s DPI without changing OCR settings or rerunning recognition', async dpi => {
    await processed(); await prepareExport('png');
    fireEvent.click(screen.getByRole('radio', { name: `${dpi} DPI` }));
    await act(async () => { fireEvent.click(screen.getByTestId('export-png-button')); });
    expect(exportCalls()[0][1]).toEqual({ file_path: output.output_path, format: 'png_zip', dpi });
    expect(api.processAction.mock.calls.filter(([action]) => action === 'desensitize')).toHaveLength(1);
    expect(api.processAction.mock.calls[0][1].settings).toEqual(expect.objectContaining({ export_dpi: 150 }));
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it.each(['keyword', 'file', 'settings'])('withdraws the draft when %s changes before confirmation', async kind => {
    await processed(); await prepareExport('png');
    const confirm = screen.getByTestId('export-png-button');
    await changeInput(kind);
    expect(screen.queryByRole('dialog', { name: '导出为图片' })).not.toBeInTheDocument();
    fireEvent.click(confirm); expect(exportCalls()).toHaveLength(0); expect(api.copyFile).not.toHaveBeenCalled();
    noResult();
  });

  it('closes the draft on a pending file choice and keeps it closed if that choice is cancelled', async () => {
    await processed(); await prepareExport('png');
    const chooser = deferred<string[]>(); api.openFile.mockReturnValueOnce(chooser.promise);
    fireEvent.click(screen.getByTestId('upload-zone'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => { chooser.resolve([]); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.getByTestId('open-export-button')).toBeEnabled();
    expect(api.saveFile).not.toHaveBeenCalled();
  });

  it('restores keyboard focus after a pending native save is cancelled', async () => {
    await processed(); const opener = screen.getByTestId('open-export-button'); opener.focus();
    const save = deferred<string | undefined>(); api.saveFile.mockReturnValueOnce(save.promise);
    await prepareExport('pdf');
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    expect(opener).toBeDisabled();
    await act(async () => { save.resolve(undefined); });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('does not steal focus from an edited draft field when an export wait ends', async () => {
    await processed(); const save = deferred<string | undefined>(); api.saveFile.mockReturnValueOnce(save.promise);
    await prepareExport('pdf');
    await act(async () => { fireEvent.click(screen.getByTestId('open-export-button')); });
    const input = screen.getByTestId('keyword-input'); input.focus();
    await act(async () => { save.resolve(undefined); });
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(input).toHaveFocus();
  });
});
