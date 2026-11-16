import React, { useState, useEffect, useRef } from 'react';
import pkg from '../../package.json';
import type { AppSettings, OcrMode, RedactionScope } from '../types/settings';
import { CREDENTIAL_STORAGE_MESSAGES, credentialStorageBlocked, DEFAULT_SETTINGS } from '../types/settings';
import { validateSettings } from '../utils/validation';
import { userError } from '../utils/userError';
import { ModalDialog } from './ModalDialog';
import type { MotionPreference } from '../utils/uiPreferences';

interface Props { onClose: (credentialsEdited?: boolean) => void; motionPreference?: MotionPreference; onMotionPreferenceChange?: (value: MotionPreference) => void; }

const OCR_OPTIONS: { value: OcrMode; label: string; desc: string }[] = [
  { value: 'local', label: '本地识别', desc: '在本机识别，不上传文档' },
  { value: 'paddle', label: 'PaddleOCR 服务', desc: '将原始 PDF 上传至配置的服务' },
  { value: 'baidu', label: '百度 OCR', desc: '将打码前的页面图像上传至百度 OCR' },
];

const REDACTION_SCOPE_OPTIONS: { value: RedactionScope; label: string; desc: string }[] = [
  { value: 'strict', label: '严格', desc: '遮盖范围较小。扫描页只在单个识别词内匹配。' },
  { value: 'normal', label: '常规', desc: '按匹配到的文字遮盖，支持部分跨行文字。' },
  { value: 'line', label: '整行', desc: '找到要遮盖的文字后，遮盖所在整行。' },
  { value: 'paragraph', label: '整段', desc: '找到要遮盖的文字后，遮盖所在段落；以识别到的文本块为准。' },
];

const RELEASES_PAGE_URL = 'https://github.com/WaterGauge/redactera/releases';

interface ChangelogEntry {
  version: string;
  publishedAt: string;
  summary: string;
}

interface NormalizedUpdateResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  notes?: string;
  publishedAt?: string;
}

function withVersionPrefix(version: string): string {
  if (!version) return version;
  return version.startsWith('v') ? version : `v${version}`;
}

function findScopeIndex(scope: RedactionScope): number {
  const idx = REDACTION_SCOPE_OPTIONS.findIndex((option) => option.value === scope);
  return idx === -1 ? 1 : idx;
}

function normalizeUpdateResult(rawResult: unknown, currentVersion: string): NormalizedUpdateResult {
  const fallbackVersion = withVersionPrefix(currentVersion || '未知');

  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
    throw new Error('Invalid update result');
  }

  const result = rawResult as Record<string, unknown>;
  if (result.error && typeof result.error === 'object' && (result.error as Record<string, unknown>).code === 'UPDATE_CHECK_RATE_LIMITED') {
    throw new Error('Update check rate limited');
  }
  if ((result.error !== undefined && result.error !== null) || (result.success !== undefined && result.success !== true)) {
    throw new Error('Update check failed');
  }
  const updateAvailable = result.updateAvailable ?? result.hasUpdate ?? result.available;
  const latestVersionRaw = result.latestVersion ?? result.version ?? (updateAvailable === false ? fallbackVersion : undefined);
  const currentVersionRaw = result.currentVersion ?? fallbackVersion;
  if (typeof updateAvailable !== 'boolean' || typeof latestVersionRaw !== 'string' || !latestVersionRaw.trim() ||
      typeof currentVersionRaw !== 'string' || !currentVersionRaw.trim()) {
    throw new Error('Invalid update result');
  }
  const releaseNotes = result.releaseNotes ?? result.notes;

  const notes = Array.isArray(releaseNotes)
    ? releaseNotes.filter((item) => typeof item === 'string').join('\n')
    : typeof releaseNotes === 'string'
      ? releaseNotes
      : undefined;

  return {
    updateAvailable,
    currentVersion: withVersionPrefix(String(currentVersionRaw || '未知')),
    latestVersion: withVersionPrefix(String(latestVersionRaw || '未知')),
    notes,
    publishedAt: typeof result.publishedAt === 'string' ? result.publishedAt : undefined,
  };
}

export function SettingsModal({ onClose, motionPreference = 'system', onMotionPreferenceChange }: Props) {
  const [draftMotion, setDraftMotion] = useState(motionPreference);
  const mountedRef = useRef(false);
  const settingsReadSequence = useRef(0);
  const editedCredentials = useRef(new Set<keyof AppSettings>());
  const loadingSettingsRef = useRef(true);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const [settingsReadError, setSettingsReadError] = useState('');
  const savingRef = useRef(false);
  const pickingFolderRef = useRef(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [validating, setValidating] = useState(false);
  const [validateMsg, setValidateMsg] = useState('');
  const [currentVersion, setCurrentVersion] = useState('加载中...');
  const [includePrerelease, setIncludePrerelease] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');
  const [updateResult, setUpdateResult] = useState<NormalizedUpdateResult | null>(null);
  const [changelogEntries, setChangelogEntries] = useState<ChangelogEntry[]>([]);

  const loadSettings = async (preserveDraft: boolean, includeCredentials = false) => {
    const sequence = ++settingsReadSequence.current;
    loadingSettingsRef.current = true;
    setLoadingSettings(true); setSettingsReadError(''); setSaveError('');
    try {
      const loaded = await window.electronAPI.getSettings(includeCredentials);
      if (!mountedRef.current || sequence !== settingsReadSequence.current) return;
      if (!validateSettings(loaded)) throw new Error('Invalid settings response');
      const preserveCredentials = preserveDraft && !credentialStorageBlocked(loaded.credential_storage_status);
      setCredentialsLoaded(includeCredentials && !credentialStorageBlocked(loaded.credential_storage_status));
      if (!preserveCredentials) editedCredentials.current.clear();
      setSettings(current => preserveDraft ? {
        ...current,
        paddle_token: preserveCredentials && editedCredentials.current.has('paddle_token') ? current.paddle_token : loaded.paddle_token,
        baidu_api_key: preserveCredentials && editedCredentials.current.has('baidu_api_key') ? current.baidu_api_key : loaded.baidu_api_key,
        baidu_secret_key: preserveCredentials && editedCredentials.current.has('baidu_secret_key') ? current.baidu_secret_key : loaded.baidu_secret_key,
        credential_storage_status: loaded.credential_storage_status,
        credential_read_id: loaded.credential_read_id,
        has_saved_credentials: loaded.has_saved_credentials,
      } : { ...DEFAULT_SETTINGS, ...loaded });
      setSettingsLoaded(true);
    } catch {
      if (!mountedRef.current || sequence !== settingsReadSequence.current) return;
      setSettingsLoaded(false);
      setSettingsReadError('无法读取设置，请重试。当前不会保存或覆盖原设置。');
    } finally {
      if (mountedRef.current && sequence === settingsReadSequence.current) {
        loadingSettingsRef.current = false;
        setLoadingSettings(false);
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void loadSettings(false);
    window.electronAPI.getAppVersion()
      .then((result) => setCurrentVersion(result || '未知'))
      .catch(() => setCurrentVersion('未知'));
    window.electronAPI.getChangelog()
      .then((result) => {
        setChangelogEntries(result.entries);
        if (result.currentVersion) {
          setCurrentVersion(result.currentVersion);
        }
      })
      .catch(() => setChangelogEntries([]));
    return () => { mountedRef.current = false; };
  }, []);

  const handleClose = () => { if (!savingRef.current && !pickingFolderRef.current) onClose(); };
  const handleSave = async () => {
    const includeCredentials = editedCredentials.current.size > 0 ||
      (credentialsLoaded && settings.credential_storage_status === 'legacy');
    if (savingRef.current || pickingFolderRef.current || loadingSettingsRef.current || !settingsLoaded ||
        settings.credential_storage_status === 'read-error' ||
        (includeCredentials && credentialStorageBlocked(settings.credential_storage_status))) return;
    savingRef.current = true; setSaving(true); setSaveError('');
    try {
      const result = await window.electronAPI.saveSettings({ ...settings }, includeCredentials);
      if (result?.success !== true) throw new Error('设置保存失败');
      onMotionPreferenceChange?.(draftMotion);
      onClose(editedCredentials.current.size > 0);
    } catch (error) {
      setSaveError(userError(error, 'settings-save'));
    } finally { savingRef.current = false; setSaving(false); }
  };

  const handleValidateBaidu = async () => {
    setValidating(true); setValidateMsg('');
    try {
      const { valid } = await window.electronAPI.validateBaidu({ apiKey: settings.baidu_api_key, secretKey: settings.baidu_secret_key });
      setValidateMsg(valid ? '验证成功' : '验证失败，请检查 API Key 和 Secret Key');
    } catch { setValidateMsg('无法验证，请检查网络后重试'); }
    finally { setValidating(false); }
  };

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    if (['paddle_token', 'baidu_api_key', 'baidu_secret_key'].includes(key)) editedCredentials.current.add(key);
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  // Old settings accepted the whole [0, 1] range and arbitrary finite
  // fractions. Show the actual stored value until the user moves the slider.
  const historicalThreshold = settings.fuzzy_match_threshold < 0.5 ||
    Math.abs(settings.fuzzy_match_threshold * 20 - Math.round(settings.fuzzy_match_threshold * 20)) > 1e-8;
  const selectedScopeIndex = findScopeIndex(settings.redaction_scope);
  const selectedScope = REDACTION_SCOPE_OPTIONS[selectedScopeIndex] ?? REDACTION_SCOPE_OPTIONS[1];
  const displayCurrentVersion = currentVersion === '加载中...' || currentVersion === '未知'
    ? currentVersion
    : `${pkg.branding.nameZh} ${withVersionPrefix(currentVersion).slice(1)}`;

  const handleOpenReleases = async () => {
    try {
      const result = await window.electronAPI.openReleasePage();
      if (result?.success !== true) throw new Error('Could not open releases');
    } catch {
      setUpdateMessage('无法打开下载页面，请手动访问下方链接');
    }
  };

  const handleCheckUpdates = async () => {
    setCheckingUpdates(true);
    setUpdateMessage('');
    setUpdateResult(null);
    try {
      const result = await window.electronAPI.checkForUpdates({ includePrerelease });
      const normalized = normalizeUpdateResult(result, currentVersion);
      setUpdateResult(normalized);

      if (normalized.updateAvailable) {
        setUpdateMessage(`发现新版本：${normalized.latestVersion}`);
      } else {
        setUpdateMessage(`已是最新版本（${normalized.currentVersion}）`);
      }
    } catch (error) {
      setUpdateMessage(error instanceof Error && error.message === 'Update check rate limited'
        ? '检查更新失败：GitHub 请求已达限制，请稍后重试或打开下载页面。'
        : '检查更新失败，请检查网络后重试');
    } finally {
      setCheckingUpdates(false);
    }
  };

  return (
    <ModalDialog className="drawer" labelledBy="settings-title" onDismiss={handleClose}>
        <div className="drawer-header">
          <h2 id="settings-title" className="drawer-title">设置</h2>
          <button type="button" className="drawer-close" aria-label="关闭设置" onClick={handleClose} disabled={saving || pickingFolder}>×</button>
        </div>

        <div className="drawer-body" inert={saving || pickingFolder}>
          <div className="form-section">
            <h3 className="form-section-title">文字识别</h3>
            <div className="radio-group" role="radiogroup" aria-label="文字识别" aria-describedby={settings.ocr_mode === 'local' ? undefined : 'cloud-ocr-data'}>
              {OCR_OPTIONS.map(opt => (
                <label key={opt.value} className={`radio-option${settings.ocr_mode === opt.value ? ' selected' : ''}`}>
                  <input type="radio" name="ocr_mode" value={opt.value} checked={settings.ocr_mode === opt.value} onChange={() => set('ocr_mode', opt.value)} />
                  <div>
                    <div className="radio-label-text">{opt.label}</div>
                    <div className="radio-label-desc">{opt.desc}</div>
                  </div>
                </label>
              ))}
            </div>
            {settings.ocr_mode !== 'local' && (
              <p id="cloud-ocr-data" className="form-help-text">云端识别发生在打码前。数据如何使用、保存和删除，由服务方决定。</p>
            )}
          </div>

          {settings.ocr_mode === 'paddle' && (
            <div className="form-section">
              <h3 className="form-section-title">PaddleOCR 配置</h3>
              {settings.has_saved_credentials && !credentialsLoaded && (
                <button type="button" className="btn-validate" disabled={loadingSettings}
                  onClick={() => void loadSettings(true, true)}>编辑已保存的凭据</button>
              )}
              <div className="form-field">
                <label className="form-label" htmlFor="paddle-url">服务地址（HTTPS）</label>
                <input id="paddle-url" className="form-input" value={settings.paddle_api_url} onChange={e => set('paddle_api_url', e.target.value)} placeholder="填写服务提供方给出的 HTTPS 地址" />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="paddle-token">访问令牌（Token）</label>
                <input id="paddle-token" className="form-input" type="password" value={settings.paddle_token} onChange={e => set('paddle_token', e.target.value)} disabled={loadingSettings || credentialStorageBlocked(settings.credential_storage_status) || (settings.has_saved_credentials && !credentialsLoaded)} placeholder={settings.has_saved_credentials && !credentialsLoaded ? '已保存' : undefined} />
              </div>
            </div>
          )}

          {settings.ocr_mode === 'baidu' && (
            <div className="form-section">
              <h3 className="form-section-title">百度 OCR 配置</h3>
              {settings.has_saved_credentials && !credentialsLoaded && (
                <button type="button" className="btn-validate" disabled={loadingSettings}
                  onClick={() => void loadSettings(true, true)}>编辑已保存的凭据</button>
              )}
              <div className="form-field">
                <label className="form-label" htmlFor="baidu-key">API Key</label>
                <input id="baidu-key" className="form-input" value={settings.baidu_api_key} onChange={e => set('baidu_api_key', e.target.value)} disabled={loadingSettings || credentialStorageBlocked(settings.credential_storage_status) || (settings.has_saved_credentials && !credentialsLoaded)} placeholder={settings.has_saved_credentials && !credentialsLoaded ? '已保存' : undefined} />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="baidu-secret">Secret Key</label>
                <input id="baidu-secret" className="form-input" type="password" value={settings.baidu_secret_key} onChange={e => set('baidu_secret_key', e.target.value)} disabled={loadingSettings || credentialStorageBlocked(settings.credential_storage_status) || (settings.has_saved_credentials && !credentialsLoaded)} placeholder={settings.has_saved_credentials && !credentialsLoaded ? '已保存' : undefined} />
              </div>
              <div className="validate-row">
                <button className="btn-validate" onClick={handleValidateBaidu} disabled={validating || loadingSettings || (settings.has_saved_credentials && !credentialsLoaded)}>
                  {validating ? '验证中...' : '验证配置'}
                </button>
                {validateMsg && <span role="status" className="validate-msg">{validateMsg}</span>}
              </div>
            </div>
          )}

          <div className="form-section">
            <h3 className="form-section-title">基础设置</h3>
            <div className="form-field">
              <label className="form-label" htmlFor="ui-motion">动态效果</label>
              <select id="ui-motion" className="form-select" value={draftMotion} onChange={event => setDraftMotion(event.target.value as MotionPreference)}>
                <option value="system">跟随系统</option><option value="off">关闭</option>
              </select>
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="ocr-language">识别语言（仅本地）</label>
              <select id="ocr-language" className="form-select" value={settings.ocr_language} disabled={settings.ocr_mode !== 'local'} onChange={e => set('ocr_language', e.target.value as AppSettings['ocr_language'])}>
                <option value="chi_sim+eng">简体中文 + 英文</option>
                <option value="chi_tra+eng">繁体中文 + 英文</option>
                <option value="eng">仅英文</option>
              </select>
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="export-dpi">识别图像分辨率（DPI）</label>
              <select id="export-dpi" className="form-select" value={settings.export_dpi} onChange={e => set('export_dpi', Number(e.target.value) as AppSettings['export_dpi'])}>
                <option value={150}>150 DPI</option>
                <option value={200}>200 DPI</option>
                <option value={300}>300 DPI</option>
              </select>
              <p className="form-help-text">本地和百度文字识别时使用，也作为 PNG 导出的默认值。</p>
            </div>
            <div className="form-field">
              <label className="form-label">
                <input
                  type="checkbox"
                  checked={settings.fuzzy_match_enabled}
                  onChange={(e) => set('fuzzy_match_enabled', e.target.checked)}
                  style={{ marginRight: '8px' }}
                />
                匹配相似文字
              </label>
              <p className="form-help-text">
                仅对至少 4 个字符的关键词查找相似文字，可能扩大打码范围。
              </p>
            </div>
            {settings.fuzzy_match_enabled && (
              <div className="form-field">
                <label className="form-label" htmlFor="fuzzy-threshold">最低相似度</label>
                <div className="form-inline">
                  <input id="fuzzy-threshold"
                    type="range"
                    min={historicalThreshold ? Math.min(0.5, settings.fuzzy_match_threshold) : 0.5}
                    max="1.0"
                    step={historicalThreshold ? "any" : "0.05"}
                    aria-valuetext={`${Math.round(settings.fuzzy_match_threshold * 100)}%`}
                    value={settings.fuzzy_match_threshold}
                    onChange={(e) => set('fuzzy_match_threshold', Math.max(0.5, Math.min(1, Math.round(Number(e.target.value) * 20) / 20)))}
                    style={{ flex: 1 }}
                  />
                  <span className="threshold-value">{(settings.fuzzy_match_threshold * 100).toFixed(0)}%</span>
                </div>
                {historicalThreshold && <p className="form-help">已保留历史相似度；主动调整滑块时采用 50%–100% 的常用范围。</p>}
              </div>
            )}
            <div className="form-field">
              <label className="form-label" htmlFor="redaction-scope-slider">遮盖范围</label>
              <input
                id="redaction-scope-slider"
                type="range"
                min="0"
                max={String(REDACTION_SCOPE_OPTIONS.length - 1)}
                step="1"
                aria-valuetext={selectedScope.label}
                value={selectedScopeIndex}
                onChange={(e) => {
                  const index = Number(e.target.value);
                  const option = REDACTION_SCOPE_OPTIONS[index];
                  if (option) {
                    set('redaction_scope', option.value);
                  }
                }}
              />
              <div className="scope-label-row">
                {REDACTION_SCOPE_OPTIONS.map((option, index) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={index === selectedScopeIndex}
                    className={`scope-label-btn${index === selectedScopeIndex ? ' active' : ''}`}
                    onClick={() => set('redaction_scope', option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="form-help-text">
                <strong>{selectedScope.label}：</strong>{selectedScope.desc}
              </p>
            </div>
          </div>

          <details className="form-section optional-settings">
            <summary>更新与版本</summary>
            <div className="form-field">
              <span className="form-label">当前版本</span>
              <div className="version-chip">{displayCurrentVersion}</div>
            </div>
            <div className="form-field">
              <label className="form-label">
                <input
                  type="checkbox"
                  checked={includePrerelease}
                  onChange={(e) => setIncludePrerelease(e.target.checked)}
                  style={{ marginRight: '8px' }}
                />
                包含测试版
              </label>
            </div>
            <div className="validate-row">
              <button className="btn-validate" onClick={handleCheckUpdates} disabled={checkingUpdates}>
                {checkingUpdates ? '检查中...' : '检查更新'}
              </button>
              <button type="button" className="btn-link-inline" onClick={handleOpenReleases}>
                打开下载页面
              </button>
            </div>
            {updateMessage && <p role="status" className="form-help-text">{updateMessage}</p>}
            {updateResult?.updateAvailable && (
              <div className="update-result-card">
                <div className="update-result-title">发现新版本：{updateResult.latestVersion}</div>
                <div className="update-result-meta">当前版本：{updateResult.currentVersion}</div>
                {updateResult.publishedAt && (
                  <div className="update-result-meta">发布时间：{updateResult.publishedAt}</div>
                )}
                {updateResult.notes && <p className="update-result-notes">{updateResult.notes}</p>}
                <button className="btn-validate" onClick={handleOpenReleases}>打开下载页面</button>
              </div>
            )}
            <p className="form-help-text">下载页面：{RELEASES_PAGE_URL}</p>
            <div className="changelog-wrapper">
              <span className="form-label">更新日志</span>
              <ul className="changelog-list">
                {[...changelogEntries].reverse().map((entry) => (
                  <li key={entry.version} className="changelog-item">
                    <span className="changelog-version">{entry.version}</span>
                    <span className="changelog-summary">{entry.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          </details>

          <details className="form-section optional-settings">
            <summary>开发者选项</summary>
            <div className="form-field">
              <label className="form-label">
                <input
                  type="checkbox"
                  checked={settings.developer_mode}
                  onChange={(e) => set('developer_mode', e.target.checked)}
                  style={{ marginRight: '8px' }}
                />
                开发者模式
              </label>
              <p className="form-help-text">日志设置在保存后应用；处理服务的日志需重启应用后切换。</p>
            </div>
            {settings.developer_mode && (
              <div className="form-field">
                <label className="form-label" htmlFor="log-folder">日志文件夹</label>
                <div className="form-inline">
                  <input id="log-folder"
                    type="text"
                    className="form-input"
                    value={settings.log_folder_path}
                    readOnly
                    placeholder="未选择文件夹"
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn-validate"
                    onClick={async () => {
                      if (savingRef.current || pickingFolderRef.current) return;
                      pickingFolderRef.current = true; setPickingFolder(true); setSaveError('');
                      try {
                        const result = await window.electronAPI.selectLogFolder();
                        if (result.success) {
                          if (!result.path) throw new Error('未获取到日志目录');
                          set('log_folder_path', result.path);
                        }
                      } catch (error) { setSaveError(userError(error, 'log-folder')); }
                      finally { pickingFolderRef.current = false; setPickingFolder(false); }
                    }}
                  >
                    选择文件夹
                  </button>
                </div>
              </div>
            )}
          </details>


        </div>

        <div className="drawer-footer">
          {loadingSettings && <div role="status">正在读取设置...</div>}
          {settingsReadError && <div role="alert">{settingsReadError}</div>}
          {settings.credential_storage_status && settings.credential_storage_status !== 'available' &&
            saveError !== CREDENTIAL_STORAGE_MESSAGES[settings.credential_storage_status] && (
            <div role="status">{CREDENTIAL_STORAGE_MESSAGES[settings.credential_storage_status]}</div>
          )}
          {(settingsReadError || saveError || (settings.credential_storage_status && settings.credential_storage_status !== 'available')) && (
            <button type="button" className="btn-drawer-cancel" onClick={() => void loadSettings(settingsLoaded, Boolean(settings.credential_storage_status && settings.credential_storage_status !== 'read-error'))}
              disabled={loadingSettings || saving || pickingFolder}>重试读取</button>
          )}
          {saveError && <div role="alert">{saveError}</div>}
          <button className="btn-drawer-cancel" onClick={handleClose} disabled={saving || pickingFolder}>取消</button>
          <button className="btn-drawer-save" onClick={handleSave}
            disabled={saving || pickingFolder || loadingSettings || !settingsLoaded || settings.credential_storage_status === 'read-error' ||
              (editedCredentials.current.size > 0 && credentialStorageBlocked(settings.credential_storage_status))}>{saving ? '正在保存...' : '保存'}</button>
        </div>
    </ModalDialog>
  );
}
