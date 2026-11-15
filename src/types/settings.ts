// src/types/settings.ts
export type OcrMode = 'local' | 'paddle' | 'baidu';
export type RedactionScope = 'strict' | 'normal' | 'loose' | 'line' | 'paragraph';
export type CredentialStorageStatus = 'available' | 'unavailable' | 'legacy' | 'locked' | 'decrypt-error' | 'read-error';

export const CREDENTIAL_STORAGE_MESSAGES: Record<CredentialStorageStatus, string> = {
  available: '',
  unavailable: '系统安全存储不可用。含 OCR 凭证的设置不会保存，请解锁系统安全存储后重试。',
  legacy: '检测到旧版明文凭证。请在系统安全存储可用时保存设置，完成加密迁移。',
  locked: '系统安全存储不可用，已保存的凭证未载入。原设置已保留，请解锁后重新读取。',
  'decrypt-error': '无法解密已保存的凭证。原设置已保留，请恢复系统安全存储或设置备份后重新读取。',
  'read-error': '无法安全读取设置。请恢复设置文件或检查读取权限后重试，当前不会覆盖原设置。',
};

export function credentialStorageBlocked(status?: CredentialStorageStatus): boolean {
  return status === 'locked' || status === 'decrypt-error' || status === 'read-error';
}

export interface AppSettings {
  ocr_mode: OcrMode;
  paddle_api_url: string;
  paddle_token: string;
  baidu_api_key: string;
  baidu_secret_key: string;
  ocr_language: 'chi_sim+eng' | 'chi_tra+eng' | 'eng';
  // Legacy key: OCR raster DPI and the default for a new PNG export draft.
  // An explicit per-export DPI does not mutate this processing setting.
  export_dpi: 150 | 200 | 300;
  fuzzy_match_enabled: boolean;
  fuzzy_match_threshold: number;
  redaction_scope: RedactionScope;
  developer_mode: boolean;
  log_folder_path: string;
  // Main-issued read metadata; never persisted or used as credentials.
  credential_storage_status?: CredentialStorageStatus;
  credential_read_id?: string;
  has_saved_credentials?: boolean;
}

export interface DesensitizationWarning {
  // Optional for responses from older backends; unknown types remain readable.
  type?: string;
  keyword: string;
  page: number | null;
  lines: string[];
  message: string;
  reason?: string;
  suggestedAction?: string;
  affectedRegions?: Array<{ kind: 'line' | 'block' | 'page' | 'document'; text?: string; id?: string }>;
}

export interface SanitizationSummary {
  policy: 'visible-page-content';
  form_fields: number;
  annotations: number;
  // Existing redaction annotations applied while making the static copy.
  // This is not the number of keyword matches from the current task.
  applied_redactions: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  ocr_mode: 'local',
  paddle_api_url: '',
  paddle_token: '',
  baidu_api_key: '',
  baidu_secret_key: '',
  ocr_language: 'chi_sim+eng',
  export_dpi: 150,
  fuzzy_match_enabled: false,
  fuzzy_match_threshold: 0.7,
  redaction_scope: 'normal',
  developer_mode: false,
  log_folder_path: '',
};
