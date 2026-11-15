// Diagnostic copies contain categories, never messages, stacks or paths.
const SAFE_ERROR_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EPIPE', 'EIO', 'EBUSY',
  'EEXIST', 'ENOTDIR', 'EISDIR', 'EMFILE', 'ENFILE', 'EROFS', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT']);

export function diagnosticErrorKind(error: unknown): string {
  try {
    if (error !== null && typeof error === 'object') {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && SAFE_ERROR_CODES.has(code)) return code;
    }
    if (error instanceof SyntaxError) return 'SyntaxError';
    if (error instanceof TypeError) return 'TypeError';
    if (error instanceof RangeError) return 'RangeError';
    return error instanceof Error ? 'Error' : 'unknown';
  } catch { return 'unknown'; }
}
