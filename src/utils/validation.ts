import { AppSettings } from '../types/settings';

export function validateSettings(settings: unknown): settings is AppSettings {
  if (typeof settings !== 'object' || settings === null) {
    return false;
  }

  const s = settings as Record<string, unknown>;

  // 验证 ocr_mode
  if (!['local', 'paddle', 'baidu'].includes(s.ocr_mode as string)) {
    return false;
  }

  // 验证 export_dpi
  if (![150, 200, 300].includes(s.export_dpi as number)) {
    return false;
  }

  // 验证 ocr_language
  if (!['chi_sim+eng', 'chi_tra+eng', 'eng'].includes(s.ocr_language as string)) {
    return false;
  }

  if (!['strict', 'normal', 'loose', 'line', 'paragraph'].includes(s.redaction_scope as string)) {
    return false;
  }

  // 验证字符串字段
  if (typeof s.paddle_api_url !== 'string' ||
      typeof s.paddle_token !== 'string' ||
      typeof s.baidu_api_key !== 'string' ||
      typeof s.baidu_secret_key !== 'string' ||
      typeof s.log_folder_path !== 'string') {
    return false;
  }

  if (typeof s.fuzzy_match_enabled !== 'boolean' ||
      typeof s.developer_mode !== 'boolean') {
    return false;
  }

  if (typeof s.fuzzy_match_threshold !== 'number' ||
      Number.isNaN(s.fuzzy_match_threshold) ||
      s.fuzzy_match_threshold < 0 ||
      s.fuzzy_match_threshold > 1) {
    return false;
  }

  if (s._encrypted !== undefined && typeof s._encrypted !== 'boolean') {
    return false;
  }
  if (s.credential_storage_status !== undefined &&
      !['available', 'unavailable', 'legacy', 'locked', 'decrypt-error', 'read-error'].includes(s.credential_storage_status as string)) {
    return false;
  }
  if (s.credential_read_id !== undefined && typeof s.credential_read_id !== 'string') return false;
  if (s.has_saved_credentials !== undefined && typeof s.has_saved_credentials !== 'boolean') return false;

  return true;
}
