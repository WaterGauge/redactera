import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  createPathValidator,
  resolvePdfSafePathFromRequest,
  sanitizeDraggedFileName,
} from '../../main/pathValidator';
import { getPythonRestartDelayMs } from '../../main/pythonProcessManager';

describe('Main process security helpers', () => {
  it('normalizes pdf-safe request paths before allowlist checks', () => {
    const rawPath = '/tmp/safe/../safe/document.pdf';
    const requestUrl = `pdf-safe://${encodeURIComponent(rawPath)}`;

    expect(resolvePdfSafePathFromRequest(requestUrl)).toBe(path.resolve('/tmp/safe/document.pdf'));
  });

  it('blocks pdf-safe requests when resolved path is not allowlisted', () => {
    const validator = createPathValidator();
    validator.addAllowedPath('/tmp/allowed.pdf');

    const requestUrl = `pdf-safe://${encodeURIComponent('/tmp/blocked.pdf')}`;
    const resolvedPath = resolvePdfSafePathFromRequest(requestUrl);

    expect(resolvedPath).toBe(path.resolve('/tmp/blocked.pdf'));
    expect(validator.isResolvedPathAllowed(resolvedPath)).toBe(false);
  });

  it('only accepts paths that stay inside allowed directories', () => {
    const validator = createPathValidator();
    const baseDir = path.resolve('/tmp/export');
    const allowedFile = path.resolve('/tmp/export/report.zip');
    const escapedFile = path.resolve('/tmp/export/../steal.zip');

    expect(validator.isPathInsideDirectory(allowedFile, baseDir)).toBe(true);
    expect(validator.isPathInsideDirectory(escapedFile, baseDir)).toBe(false);
  });

  it('sanitizes dragged file names with normalization and traversal prevention', () => {
    const sanitized = sanitizeDraggedFileName('../e\u0301vil/..//report???..ＰＤＦ');

    expect(sanitized).toBe('evil_report.pdf');
    expect(sanitized).not.toContain('..');
    expect(sanitized).not.toContain('/');
  });

  it('uses capped exponential backoff for python restarts', () => {
    expect(getPythonRestartDelayMs(0)).toBe(1000);
    expect(getPythonRestartDelayMs(1)).toBe(2000);
    expect(getPythonRestartDelayMs(4)).toBe(16000);
    expect(getPythonRestartDelayMs(9)).toBe(30000);
  });
});
