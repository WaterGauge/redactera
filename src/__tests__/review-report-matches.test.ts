import { describe, expect, it } from 'vitest';
import { parseReviewReport } from '../types/processing';

const report = (matchKinds?: unknown, words = ['SECRET']) => ({ version: 1, pageCount: 1, regions: [{
  id: 'r1', page: 1, origin: 'keyword', keywords: words,
  polygon: [[.1, .1], [.2, .1], [.2, .2], [.1, .2]],
  ...(matchKinds === undefined ? {} : { matchKinds }),
}] });

describe('Per-keyword match provenance', () => {
  it('preserves exact and approximate methods without treating legacy data as exact', () => {
    expect(parseReviewReport(report({ SECRET: 'approximate' }))?.regions[0].matchKinds).toEqual({ SECRET: 'approximate' });
    expect(parseReviewReport(report())?.regions[0].matchKinds).toBeUndefined();
  });
  it.each([null, [], { OTHER: 'exact' }, { SECRET: 'unknown' }])('rejects an invalid extension: %s', kinds => {
    expect(() => parseReviewReport(report(kinds))).toThrow('无法读取遮盖位置');
  });
  it('keeps literal object-property names as data', () => {
    const kinds = JSON.parse('{"__proto__":"exact"}');
    const parsed = parseReviewReport(report(kinds, ['__proto__']))?.regions[0].matchKinds;
    expect(Object.prototype.hasOwnProperty.call(parsed ?? {}, '__proto__')).toBe(true);
    expect(parsed?.['__proto__']).toBe('exact');
  });
});
