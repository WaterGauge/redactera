export const PROCESSING_STAGES = [
  'preparing', 'ocr', 'redacting', 'exporting', 'finalizing', 'validating',
] as const;
export type ProcessingStage = typeof PROCESSING_STAGES[number];

export function isProcessingStage(value: unknown): value is ProcessingStage {
  return typeof value === 'string' && (PROCESSING_STAGES as readonly string[]).includes(value);
}

export interface ProcessingProgress {
  stage: ProcessingStage;
  message: string;
  elapsedMs: number;
  completed?: number;
  total?: number;
}

export interface OperationProgress extends ProcessingProgress {
  operationId: string;
}

export type MatchKind = 'exact' | 'approximate' | 'mixed';

export interface ReviewRegion {
  readonly id: string;
  readonly page: number;
  readonly origin: 'keyword' | 'existing';
  readonly keywords: readonly string[];
  readonly matchKinds?: Readonly<Record<string, MatchKind>>;
  // Polygon clipped to the displayed CropBox, normalized to [0, 1].
  readonly polygon: ReadonlyArray<readonly [number, number]>;
}

export interface ReviewReport {
  readonly version: 1;
  readonly pageCount: number;
  readonly regions: readonly ReviewRegion[];
}

/** Missing legacy metadata is distinct from a valid report with zero masks. */
export function parseReviewReport(value: unknown): ReviewReport | null {
  if (value === undefined) return null;
  const invalid = () => { throw new Error('无法读取遮盖位置，请重新处理；仍失败时请检查应用版本。'); };
  if (!value || typeof value !== 'object') return invalid();
  const report = value as Record<string, unknown>;
  if (report.version !== 1 || !Number.isSafeInteger(report.pageCount) || (report.pageCount as number) < 1 ||
      !Array.isArray(report.regions) || report.regions.length > 100_000) return invalid();
  const ids = new Set<string>();
  const regions = report.regions.map((item: unknown): ReviewRegion => {
    if (!item || typeof item !== 'object') return invalid();
    const region = item as Record<string, unknown>;
    if (typeof region.id !== 'string' || !region.id || ids.has(region.id) ||
        !Number.isSafeInteger(region.page) || (region.page as number) < 1 || (region.page as number) > (report.pageCount as number) ||
        (region.origin !== 'keyword' && region.origin !== 'existing') ||
        !Array.isArray(region.keywords) || !region.keywords.every(word => typeof word === 'string' && word.length > 0) ||
        (region.origin === 'keyword' ? region.keywords.length === 0 : region.keywords.length > 0) ||
        !Array.isArray(region.polygon) || region.polygon.length < 3 || region.polygon.length > 8) return invalid();
    let matchKinds: Readonly<Record<string, MatchKind>> | undefined;
    if (region.matchKinds !== undefined) {
      if (!region.matchKinds || typeof region.matchKinds !== 'object' || Array.isArray(region.matchKinds) ||
          region.origin !== 'keyword') return invalid();
      const entries = Object.entries(region.matchKinds as Record<string, unknown>);
      if (entries.some(([word, kind]) => !(region.keywords as string[]).includes(word) ||
          !['exact', 'approximate', 'mixed'].includes(kind as string))) return invalid();
      matchKinds = Object.fromEntries(entries) as Record<string, MatchKind>;
    }
    const polygon = region.polygon.map((point: unknown): readonly [number, number] => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return invalid();
      return [point[0], point[1]];
    });
    const twiceArea = Math.abs(polygon.reduce((area, point, index) => {
      const next = polygon[(index + 1) % polygon.length];
      return area + point[0] * next[1] - next[0] * point[1];
    }, 0));
    if (twiceArea <= 0) return invalid();
    ids.add(region.id);
    return { id: region.id, page: region.page as number, origin: region.origin,
      keywords: [...region.keywords], polygon, ...(matchKinds ? { matchKinds } : {}) };
  });
  return { version: 1, pageCount: report.pageCount as number, regions };
}
