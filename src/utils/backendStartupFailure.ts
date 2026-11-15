// Windows loader statuses identify a dependency failure, not which DLL is missing.
export const BACKEND_STARTUP_MESSAGES = {
  missingDependency: '处理组件缺少所需的运行库。请按安装说明检查 Microsoft Visual C++ x64 运行库，或重新安装页隐。',
  invalidImage: '处理组件或运行库已损坏，或版本不兼容。请重新安装 x64 版页隐和 Microsoft Visual C++ 运行库后重试。',
} as const;

export function backendStartupFailure(code: number | null): string | undefined {
  // Node can report a Windows NTSTATUS as a signed or unsigned 32-bit integer.
  if (code === null || !Number.isInteger(code) || code < -0x80000000 || code > 0xffffffff) return undefined;
  switch (code >>> 0) {
    case 0xc0000135: return BACKEND_STARTUP_MESSAGES.missingDependency;
    case 0xc000012f:
    case 0xc000007b: return BACKEND_STARTUP_MESSAGES.invalidImage;
    default: return undefined;
  }
}
