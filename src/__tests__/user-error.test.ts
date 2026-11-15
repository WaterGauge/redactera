import { describe, expect, it } from 'vitest';
import { userError } from '../utils/userError';

describe('actionable error messages', () => {
  it('explains an actual Electron file permission rejection without its path or channel', () => {
    const error = new Error("Error invoking remote method 'pdf:process': Error: EPERM: operation not permitted, open '/private/customer.pdf'");
    expect(userError(error, 'open')).toBe('无法读取文件，请检查文件权限，或将文件移到可访问的文件夹后重新选择。');
    expect(userError(error, 'export')).toBe('无法保存文件，请检查保存位置的权限，或换一个文件夹后重试。');
  });
  it('retains the safe credential recovery instruction', () => {
    const instruction = '设置已变更或凭证未成功载入，请重新读取设置后再保存。';
    expect(userError(new Error(`Error invoking remote method 'settings:save': Error: ${instruction}`), 'settings-save')).toBe(instruction);
  });
  it('gives a recovery action for malformed PDF and unsupported signature failures', () => {
    expect(userError(new Error('Failed to open file /private/customer.pdf'), 'process')).toContain('未损坏、未加密');
    expect(userError(new Error('暂不处理带数字签名的PDF，请先生成无签名的静态副本'), 'process')).toContain('不带签名的副本');
  });
  it('does not display a provider body or credential on an authorization failure', () => {
    const result = userError(new Error('PaddleOCR job submit failed 401: private-token customer-content'), 'process');
    expect(result).toBe('文字识别服务拒绝了请求，请检查服务凭证和可用额度后重试。');
  });
  it('explains timeout and unconfirmed cancellation as different states', () => {
    expect(userError(new Error('Request deadline exceeded'), 'process')).toContain('处理时间过长');
    expect(userError(new Error('Cannot confirm backend termination'), 'process')).toContain('尚未确认处理已停止');
  });
  it('uses a safe contextual message for unknown objects and arbitrary Chinese errors', () => {
    expect(userError({ message: 'private-token' }, 'settings-save')).toBe('设置保存失败，请重试。');
    expect(userError('内部错误：private-token /private/customer.pdf', 'export')).toBe('无法导出文件，请检查保存位置的权限和可用空间后重试。');
  });
});
