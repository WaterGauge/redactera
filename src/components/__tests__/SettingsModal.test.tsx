import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SettingsModal } from '../SettingsModal';
import { DEFAULT_SETTINGS } from '../../types/settings';

// Mock electron API
const mockElectronAPI = {
  getSettings: vi.fn().mockResolvedValue({
    ocr_mode: 'local',
    ocr_language: 'chi_sim+eng',
    export_dpi: 150,
    fuzzy_match_enabled: false,
    fuzzy_match_threshold: 0.8,
    redaction_scope: 'normal',
    developer_mode: false,
    log_folder_path: '',
    paddle_api_url: '',
    paddle_token: '',
    baidu_api_key: '',
    baidu_secret_key: '',
  }),
  getAppVersion: vi.fn().mockResolvedValue('1.2.1-beta.3'),
  getChangelog: vi.fn().mockResolvedValue({
    currentVersion: '1.2.1-beta.3',
    entries: [
      { version: 'v1.0.0', publishedAt: '2026-02-27', summary: '首个正式发布版本' },
      { version: 'v1.2.1-beta.3', publishedAt: '2026-04-01', summary: '新增更新与版本模块、五档打码范围，并收敛 CI 到 macOS / Windows。' },
    ],
  }),
  checkForUpdates: vi.fn().mockResolvedValue({
    updateAvailable: false,
    currentVersion: '1.2.1-beta.3',
    latestVersion: '1.2.1-beta.3',
  }),
  openReleasePage: vi.fn().mockResolvedValue({ success: true }),
  saveSettings: vi.fn().mockResolvedValue({ success: true }),
  selectLogFolder: vi.fn().mockResolvedValue({ success: false }),
  validateBaidu: vi.fn().mockResolvedValue({ valid: true }),
};

(global as any).window = {
  electronAPI: mockElectronAPI,
};

describe('SettingsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([0, 0.2, 0.731, 1])('preserves historical fuzzy threshold %s when other settings change', async threshold => {
    mockElectronAPI.getSettings.mockResolvedValueOnce({ ...DEFAULT_SETTINGS,
      fuzzy_match_enabled: true, fuzzy_match_threshold: threshold });
    render(<SettingsModal onClose={vi.fn()} />);
    const slider = await screen.findByLabelText('最低相似度');
    expect(Number((slider as HTMLInputElement).value)).toBe(threshold);
    fireEvent.change(screen.getByLabelText('遮盖范围'), { target: { value: '3' } });
    await act(async () => { fireEvent.click(screen.getByText('保存')); });
    await vi.waitFor(() => expect(mockElectronAPI.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      fuzzy_match_threshold: threshold,
    }), false));
  });

  it('returns to the normal threshold steps only on deliberate adjustment', async () => {
    mockElectronAPI.getSettings.mockResolvedValueOnce({ ...DEFAULT_SETTINGS,
      fuzzy_match_enabled: true, fuzzy_match_threshold: 0.2 });
    render(<SettingsModal onClose={vi.fn()} />);
    const slider = await screen.findByLabelText('最低相似度');
    expect(screen.getByText(/已保留历史相似度/)).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: '0.83' } });
    expect(Number((slider as HTMLInputElement).value)).toBe(0.85);
    expect(screen.queryByText(/已保留历史相似度/)).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText('保存')); });
    await vi.waitFor(() => expect(mockElectronAPI.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      fuzzy_match_threshold: 0.85,
    }), false));
  });

  it('应该渲染设置对话框', async () => {
    const mockOnClose = vi.fn();
    render(<SettingsModal onClose={mockOnClose} />);

    expect(await screen.findByText('设置')).toBeInTheDocument();
  });

  it('应该显示 OCR 模式选项', async () => {
    const mockOnClose = vi.fn();
    render(<SettingsModal onClose={mockOnClose} />);

    expect(await screen.findByText('本地识别')).toBeInTheDocument();
    expect(screen.getByText('PaddleOCR 服务')).toBeInTheDocument();
    expect(screen.getByText('百度 OCR')).toBeInTheDocument();
  });

  it('defaults to local OCR and explains original-content transfer only when a cloud service is chosen', async () => {
    render(<SettingsModal onClose={vi.fn()} />);
    await screen.findByText('在本机识别，不上传文档');
    await vi.waitFor(() => expect(mockElectronAPI.getSettings).toHaveBeenCalled());
    const options = screen.getAllByRole('radio');
    expect(options[0]).toBeChecked();
    expect(screen.queryByText('云端识别发生在打码前。数据如何使用、保存和删除，由服务方决定。')).not.toBeInTheDocument();

    fireEvent.click(options[1]);
    expect(screen.getByRole('radiogroup', { name: '文字识别' })).toHaveAccessibleDescription(
      '云端识别发生在打码前。数据如何使用、保存和删除，由服务方决定。'
    );
    expect(screen.getByText('将原始 PDF 上传至配置的服务')).toBeInTheDocument();
    expect(screen.getByLabelText('服务地址（HTTPS）')).toBeInTheDocument();

    fireEvent.click(options[2]);
    expect(screen.getByText('将打码前的页面图像上传至百度 OCR')).toBeInTheDocument();
    expect(mockElectronAPI.validateBaidu).not.toHaveBeenCalled();

    fireEvent.click(options[0]);
    expect(screen.getByRole('radiogroup', { name: '文字识别' })).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('云端识别发生在打码前。数据如何使用、保存和删除，由服务方决定。')).not.toBeInTheDocument();
  });

  it('应该渲染更新与版本区域和完整更新日志', async () => {
    const mockOnClose = vi.fn();
    render(<SettingsModal onClose={mockOnClose} />);

    expect(await screen.findByText('更新与版本')).toBeInTheDocument();
    expect(screen.getByText('当前版本')).toBeInTheDocument();
    expect(mockElectronAPI.getChangelog).toHaveBeenCalled();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    expect(await screen.findByText('页隐 1.2.1-beta.3')).toBeInTheDocument();
    expect(screen.getByText('v1.2.1-beta.3')).toBeInTheDocument();
  });

  it('应该允许调整遮盖范围并在保存时提交', async () => {
    const mockOnClose = vi.fn();
    render(<SettingsModal onClose={mockOnClose} />);

    const slider = await screen.findByLabelText('遮盖范围');
    fireEvent.change(slider, { target: { value: '3' } });

    await act(async () => { fireEvent.click(screen.getByText('保存')); });

    await vi.waitFor(() => {
      expect(mockElectronAPI.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          redaction_scope: 'paragraph',
        }), false
      );
    });
  });

  it('应该支持检查更新并显示新版本详情', async () => {
    mockElectronAPI.checkForUpdates.mockResolvedValueOnce({
      updateAvailable: true,
      currentVersion: '1.2.1-beta.3',
      latestVersion: '1.2.1',
      releaseNotes: '稳定性与性能优化',
      publishedAt: '2026-03-31',
    });

    const mockOnClose = vi.fn();
    render(<SettingsModal onClose={mockOnClose} />);

    await screen.findByText('更新与版本');
    await act(async () => {
      fireEvent.click(screen.getByText('检查更新'));
    });

    await vi.waitFor(() => {
      expect(mockElectronAPI.checkForUpdates).toHaveBeenCalledWith({ includePrerelease: false });
    });

    expect((await screen.findAllByText('发现新版本：v1.2.1')).length).toBeGreaterThan(0);
    expect(screen.getByText('稳定性与性能优化')).toBeInTheDocument();
  });

  it('在线检查失败时也应保留更新日志并可打开下载页面', async () => {
    mockElectronAPI.checkForUpdates.mockRejectedValueOnce(new Error('offline'));

    const mockOnClose = vi.fn();
    render(<SettingsModal onClose={mockOnClose} />);

    await screen.findByText('更新与版本');
    await act(async () => {
      fireEvent.click(screen.getByText('检查更新'));
    });

    expect(await screen.findByText('检查更新失败，请检查网络后重试')).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();

    fireEvent.click(screen.getByText('打开下载页面'));
    await vi.waitFor(() => {
      expect(mockElectronAPI.openReleasePage).toHaveBeenCalled();
    });
  });

  it('应该在点击关闭按钮时调用 onClose', async () => {
    const mockOnClose = vi.fn();
    render(<SettingsModal onClose={mockOnClose} />);

    await screen.findByText('设置');
    const closeButton = screen.getByRole('button', { name: '关闭设置' });
    fireEvent.click(closeButton);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it('应该在点击取消按钮时调用 onClose', async () => {
    const mockOnClose = vi.fn();
    render(<SettingsModal onClose={mockOnClose} />);

    await screen.findByText('设置');
    const cancelButton = screen.getByText('取消');
    fireEvent.click(cancelButton);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it('应该在点击保存按钮时保存设置', async () => {
    const mockOnClose = vi.fn();
    render(<SettingsModal onClose={mockOnClose} />);

    await screen.findByText('设置');
    const saveButton = screen.getByText('保存');
    await act(async () => { fireEvent.click(saveButton); });

    await vi.waitFor(() => {
      expect(mockElectronAPI.saveSettings).toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });
  });
});
