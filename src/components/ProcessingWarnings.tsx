import React from 'react';
import type { DesensitizationWarning } from '../types/settings';

const LABELS = new Map([
  ['cross_line', '跨行匹配'], ['coarse_location', '遮盖范围较大'],
  ['low_confidence', '文字可能识别不准'], ['no_match', '未找到要打码的文字'],
  ['outline_text', '请核对轮廓文字'],
]);

export function ProcessingWarnings({ warnings, onPreviewPage, disabled }: {
  warnings: readonly DesensitizationWarning[];
  onPreviewPage: (page: number) => void;
  disabled: boolean;
}) {
  if (!warnings.length) return null;
  return <section data-testid="processing-warnings" aria-label="处理提示" className="warning-box">
    <h3>处理提示（{warnings.length}）</h3>
    {warnings.map((warning, index) => {
      const kind = warning.type ?? '', page = warning.page;
      const knownPage = typeof page === 'number' && Number.isSafeInteger(page) && page > 0;
      const regions = Array.isArray(warning.affectedRegions) ? warning.affectedRegions : [];
      const regionText = regions.map(region => region?.text).filter((text): text is string => typeof text === 'string' && !!text);
      const lines = regionText.length ? regionText : LABELS.has(kind) && Array.isArray(warning.lines)
        ? warning.lines.filter(text => typeof text === 'string' && !!text) : [];
      const title = kind === 'no_match' && warning.keyword ? `未找到“${warning.keyword}”` : LABELS.get(kind) ?? '处理提示';
      return <article key={index} className="warning-item">
        <strong>{title}</strong>
        {knownPage && <button type="button" className="warning-page" disabled={disabled}
          aria-label={`查看第 ${page} 页`} onClick={() => onPreviewPage(page)}>第 {page} 页</button>}
        {!LABELS.has(kind) && warning.message && <p>{warning.message}</p>}
        <details className="warning-details"><summary>详情</summary>
          {LABELS.has(kind) && warning.message && <p>{warning.message}</p>}
          {kind !== 'no_match' && warning.keyword && <p>文字：{warning.keyword}</p>}
          {warning.reason && <p>{warning.reason}</p>}
          {!!lines.length && <ul aria-label="相关文本">{lines.map((line, i) => <li key={i}>{line}</li>)}</ul>}
          {warning.suggestedAction && <p>{warning.suggestedAction}</p>}
        </details>
      </article>;
    })}
  </section>;
}
