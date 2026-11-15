import { describe, expect, it } from 'vitest';
import { parseReviewReport } from '../types/processing';

const region = { id: 'r1', page: 1, origin: 'keyword', keywords: ['SECRET'], polygon: [[0.1, 0.2], [0.4, 0.2], [0.4, 0.3], [0.1, 0.3]] };
const report = { version: 1, pageCount: 2, regions: [region] };
it('distinguishes a legacy missing report from zero actual masks', () => {
  expect(parseReviewReport(undefined)).toBeNull();
  expect(parseReviewReport({ ...report, regions: [] })?.regions).toEqual([]);
});
it('copies only the geometry contract, without path authorization or source text', () => {
  const parsed = parseReviewReport({ ...report, output_path: '/private', regions: [{ ...region, sourceText: 'PRIVATE' }] });
  expect(parsed).toEqual(report); expect(parsed?.regions[0]).not.toBe(region);
});
describe('rejects present but unusable geometry rather than reporting zero matches', () => {
  it.each([null, {}, { ...report, version: 2 }, { ...report, pageCount: 0 }, { ...report, pageCount: 1.2 },
    { ...report, regions: [region, region] }, ...[
      { id: '' }, { page: 3 }, { page: NaN }, { origin: 'guessed' }, { keywords: [] }, { origin: 'existing' },
      { polygon: [[0, 0], [0, 0], [0, 0]] }, { polygon: [[0, 0], [1, 0], [1, Infinity]] },
      { polygon: [[0, 0], [1, 0], [1, 1.01]] }, { polygon: [[0, 0], [1, 0]] },
    ].map(patch => ({ ...report, regions: [{ ...region, ...patch }] })),
  ])('refuses invalid report %#', value => expect(() => parseReviewReport(value)).toThrow('无法读取遮盖位置'));
});
