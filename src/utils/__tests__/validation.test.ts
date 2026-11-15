import { describe, it, expect } from 'vitest';
import { validateSettings } from '../validation';

describe('validateSettings', () => {
  it('应该验证有效的设置对象', () => {
    const validSettings = {
      ocr_mode: 'local',
      export_dpi: 300,
      ocr_language: 'chi_sim+eng',
      paddle_api_url: 'http://localhost:8000',
      paddle_token: 'test-token',
      baidu_api_key: 'test-key',
      baidu_secret_key: 'test-secret',
      fuzzy_match_enabled: false,
      fuzzy_match_threshold: 0.7,
      redaction_scope: 'normal',
      developer_mode: false,
      log_folder_path: '',
    };
    expect(validateSettings(validSettings)).toBe(true);
  });

  it('应该拒绝无效的 OCR 模式', () => {
    const invalidSettings = {
      ocr_mode: 'invalid',
      export_dpi: 300,
      ocr_language: 'chi_sim+eng',
      paddle_api_url: '',
      paddle_token: '',
      baidu_api_key: '',
      baidu_secret_key: '',
    };
    expect(validateSettings(invalidSettings)).toBe(false);
  });

  it('应该拒绝无效的 DPI 值', () => {
    const invalidSettings = {
      ocr_mode: 'local',
      export_dpi: 999,
      ocr_language: 'chi_sim+eng',
      paddle_api_url: '',
      paddle_token: '',
      baidu_api_key: '',
      baidu_secret_key: '',
    };
    expect(validateSettings(invalidSettings)).toBe(false);
  });

  it('应该拒绝无效的语言设置', () => {
    const invalidSettings = {
      ocr_mode: 'local',
      export_dpi: 300,
      ocr_language: 'invalid',
      paddle_api_url: '',
      paddle_token: '',
      baidu_api_key: '',
      baidu_secret_key: '',
    };
    expect(validateSettings(invalidSettings)).toBe(false);
  });

  it('应该拒绝 null 或非对象', () => {
    expect(validateSettings(null)).toBe(false);
    expect(validateSettings(undefined)).toBe(false);
    expect(validateSettings('string')).toBe(false);
    expect(validateSettings(123)).toBe(false);
  });

  it('应该拒绝缺少必需字段的对象', () => {
    const incompleteSettings = {
      ocr_mode: 'local',
      export_dpi: 300,
      // 缺少其他必需字段
    };
    expect(validateSettings(incompleteSettings)).toBe(false);
  });
});
