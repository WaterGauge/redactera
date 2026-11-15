import type { DesensitizationWarning } from './types/settings';
import type { ReviewReport } from './types/processing';

// Commas and spaces can be part of names/addresses; only a newline separates terms.
export function readKeywords(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map(word => word.trim()).filter(Boolean))];
}

export function keywordMaskCount(report: ReviewReport): number {
  return report.regions.filter(region => region.origin === 'keyword').length;
}

export function needsExportDecision(report: ReviewReport, warnings: readonly DesensitizationWarning[]): boolean {
  return keywordMaskCount(report) === 0 || warnings.some(warning => warning.type !== 'cross_line');
}

export function exportName(fileName: string | null, format: 'pdf' | 'png_zip', hasMasks = true): string {
  const base = (fileName ?? '文档.pdf').replace(/\.pdf$/i, '');
  return `${base}_${hasMasks ? '已打码' : '副本'}.${format === 'pdf' ? 'pdf' : 'zip'}`;
}
