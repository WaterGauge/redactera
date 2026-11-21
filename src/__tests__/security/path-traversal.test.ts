import path from 'path';
import { describe, expect, it } from 'vitest';
import { createPathValidator, resolvePdfSafePathFromRequest } from '../../main/pathValidator';

describe('Security: Path Traversal Prevention', () => {
  it('blocks encoded pdf-safe paths that resolve outside the allowlist', () => {
    const validator = createPathValidator();
    validator.addAllowedPath('/Users/user/Documents/file.pdf');

    const requestUrl = `pdf-safe://${encodeURIComponent('/Users/user/Documents/../Secrets/file.pdf')}`;
    const resolvedPath = resolvePdfSafePathFromRequest(requestUrl);

    expect(resolvedPath).toBe(path.resolve('/Users/user/Secrets/file.pdf'));
    expect(validator.isResolvedPathAllowed(resolvedPath)).toBe(false);
  });

  it('blocks every write destination except the selected file after normalization', () => {
    const validator = createPathValidator();
    const chosen = path.resolve('/tmp/export/result.pdf');
    validator.setWriteTarget({ filePath: chosen, realParent: path.dirname(chosen) });

    expect(validator.claimWriteTarget('/tmp/export/final.pdf')).toBeNull();
    expect(validator.claimWriteTarget('/tmp/export/../steal/final.pdf')).toBeNull();
    expect(validator.claimWriteTarget('/tmp/export/../export/result.pdf')).toEqual({
      filePath: chosen, realParent: path.dirname(chosen),
    });
    expect(validator.claimWriteTarget(chosen)).toBeNull();
  });

  it('allows valid user document paths after resolution', () => {
    const validator = createPathValidator();
    const allowedPath = '/Users/user/Documents/file.pdf';
    const resolvedPath = validator.addAllowedPath(allowedPath);

    expect(resolvedPath).toBe(path.resolve(allowedPath));
    expect(validator.isResolvedPathAllowed(path.resolve(allowedPath))).toBe(true);
  });
});
