import React, { useMemo, useState } from 'react';
import type { ReviewRegion, ReviewReport } from '../types/processing';

function kindForWord(region: ReviewRegion, word: string) {
  const kinds = region.matchKinds;
  return kinds && Object.prototype.hasOwnProperty.call(kinds, word) ? kinds[word] : undefined;
}

export function ReviewRegions({ report, keywords, selected, disabled, onLocate }: {
  report: ReviewReport;
  keywords: readonly string[];
  selected?: string;
  disabled: boolean;
  onLocate: (page: number, id: string) => void;
}) {
  const [activeWord, setActiveWord] = useState<string | null>(null);
  const groups = useMemo(() => {
    const byWord = new Map<string, ReviewRegion[]>();
    for (const region of report.regions) {
      if (region.origin !== 'keyword') continue;
      for (const word of new Set(region.keywords)) {
        const group = byWord.get(word) ?? [];
        group.push(region); byWord.set(word, group);
      }
    }
    return byWord;
  }, [report]);
  const masks = report.regions.filter(region => region.origin === 'keyword').length;
  const existing = report.regions.length - masks;
  const locations = activeWord ? groups.get(activeWord) ?? [] : [];
  const index = locations.findIndex(region => region.id === selected);
  const matchKind = activeWord && index >= 0 ? kindForWord(locations[index], activeWord) : undefined;
  const locate = (position: number) => {
    const region = locations[position];
    if (region) onLocate(region.page, region.id);
  };
  return <section className="result-summary" aria-label="打码结果">
    <div aria-live="polite"><h2>{masks ? `已打码 ${masks} 处` : '未找到要打码的文字'}</h2>
      <p className="muted-text">已处理 {report.pageCount} 页</p></div>
    <ul className="result-words">
      {keywords.map(word => {
        const matches = groups.get(word) ?? [];
        const approximate = matches.filter(region => ['approximate', 'mixed'].includes(kindForWord(region, word) ?? '')).length;
        return <li key={word}><button type="button" disabled={disabled || !matches.length}
          aria-label={`查看“${word}”的遮盖位置`} aria-pressed={activeWord === word}
          onClick={() => { setActiveWord(word); onLocate(matches[0].page, matches[0].id); }}>
          <span>{word}</span><span className="result-word-count">{matches.length ? matches.length + ' 处' + (approximate ? ' · 近似 ' + approximate + ' 处' : '') : '未找到'}</span>
          {!!matches.length && <span aria-hidden="true" className="location-arrow">›</span>}
        </button></li>;
      })}
    </ul>
    {matchKind && <p className="muted-text">{matchKind === 'approximate' ? '近似匹配' : matchKind === 'mixed' ? '精确及近似匹配' : '精确匹配'} · 第 {locations[index].page} 页</p>}
    {locations.length > 1 && index >= 0 && <nav className="result-locations" aria-label="遮盖位置导航">
      <button type="button" aria-label="上一处遮盖" disabled={disabled || index <= 0} onClick={() => locate(index - 1)}>‹</button>
      <label>位置 <input type="number" aria-label="遮盖位置序号" min={1} max={locations.length} value={index + 1} disabled={disabled}
        onChange={event => { const next = Number(event.target.value); if (Number.isSafeInteger(next) && next >= 1 && next <= locations.length) locate(next - 1); }} /></label>
      <span>/ {locations.length}</span>
      <button type="button" aria-label="下一处遮盖" disabled={disabled || index >= locations.length - 1} onClick={() => locate(index + 1)}>›</button>
    </nav>}
    {!!existing && <p className="muted-text">原件已有 {existing} 处遮盖</p>}
  </section>;
}
