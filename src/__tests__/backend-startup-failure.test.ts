import { describe, expect, it } from 'vitest';
import { backendStartupFailure, BACKEND_STARTUP_MESSAGES } from '../utils/backendStartupFailure';
import { userError } from '../utils/userError';

describe('backend startup dependency errors', () => {
  it.each([0xc0000135, -1073741515, 0xc000007b, -1073741701, 0xc000012f, -1073741521])('preserves safe guidance for %s across IPC', code => {
    const message = backendStartupFailure(code);
    expect(Object.values(BACKEND_STARTUP_MESSAGES)).toContain(message);
    expect(userError(new Error(`Error invoking remote method 'pdf:process': Error: ${message}`), 'process')).toBe(message);
  });
  it.each([null, 0, 1, 126, 127, 0xc0000005, NaN, Infinity, 0xc0000135 + 0x100000000, -0x100000001, 1.5])(
    'does not guess missing dependencies for %s', code => expect(backendStartupFailure(code)).toBeUndefined()
  );
  it('does not echo arbitrary backend paths or DLL names', () => {
    expect(userError(new Error('Missing provider-secret C:/private/sample.dll'), 'process')).toBe('处理未完成，请重试；若仍失败，请更换文件或识别方式。');
  });
});
