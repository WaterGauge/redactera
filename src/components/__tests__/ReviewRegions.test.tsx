import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReviewRegions } from '../ReviewRegions';
import type { ReviewReport } from '../../types/processing';

afterEach(cleanup);
it('keeps every mask reachable by keyword without rendering or confirming a hundred checkboxes', () => {
  const report: ReviewReport = { version: 1, pageCount: 2, regions: Array.from({ length: 101 }, (_, index) => ({
    id: `r${index + 1}`, page: index === 100 ? 2 : 1, origin: 'keyword', keywords: ['张三'],
    polygon: [[.1, .2], [.2, .2], [.2, .3], [.1, .3]],
  })) };
  const locate = vi.fn();
  const view = render(<ReviewRegions report={report} keywords={['张三', '未找到']} disabled={false} onLocate={locate} />);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '查看“未找到”的遮盖位置' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '查看“张三”的遮盖位置' }));
  expect(locate).toHaveBeenCalledWith(1, 'r1');
  view.rerender(<ReviewRegions report={report} keywords={['张三', '未找到']} selected="r1" disabled={false} onLocate={locate} />);
  fireEvent.change(screen.getByRole('spinbutton', { name: '遮盖位置序号' }), { target: { value: '101' } });
  expect(locate).toHaveBeenLastCalledWith(2, 'r101');
  view.rerender(<ReviewRegions report={report} keywords={['张三', '未找到']} selected="r101" disabled={true} onLocate={locate} />);
  expect(screen.getByRole('button', { name: '下一处遮盖' })).toBeDisabled();
  expect(screen.getByRole('spinbutton')).toBeDisabled();
});
it('counts actual merged masks once and separates existing redactions from keyword results', () => {
  const geometry = { page: 1, polygon: [[.1, .1], [.2, .1], [.2, .2], [.1, .2]] as Array<readonly [number, number]> };
  const report: ReviewReport = { version: 1, pageCount: 1, regions: [
    { ...geometry, id: 'new', origin: 'keyword', keywords: ['张三', '张', '张三'] },
    { ...geometry, id: 'existing', origin: 'existing', keywords: [] },
  ] };
  render(<ReviewRegions report={report} keywords={['张三', '张']} disabled={false} onLocate={vi.fn()} />);
  expect(screen.getByRole('heading')).toHaveTextContent('已打码 1 处');
  expect(screen.getByText('原件已有 1 处遮盖')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '查看“张三”的遮盖位置' })).toHaveTextContent('1 处');
});

it('distinguishes the selected keyword method even when two keywords share one mask', () => {
  const report: ReviewReport = { version: 1, pageCount: 1, regions: [{
    id: 'r1', page: 1, origin: 'keyword', keywords: ['SECRET', 'SECRE7'],
    matchKinds: { SECRET: 'exact', SECRE7: 'approximate' },
    polygon: [[.1, .1], [.2, .1], [.2, .2], [.1, .2]],
  }] };
  const locate = vi.fn();
  const view = render(<ReviewRegions report={report} keywords={['SECRET', 'SECRE7']} selected="r1" disabled={false} onLocate={locate} />);
  expect(screen.getByRole('button', { name: '查看“SECRET”的遮盖位置' })).not.toHaveTextContent('近似');
  expect(screen.getByRole('button', { name: '查看“SECRE7”的遮盖位置' })).toHaveTextContent('近似 1 处');
  fireEvent.click(screen.getByRole('button', { name: '查看“SECRET”的遮盖位置' }));
  expect(screen.getByText('精确匹配 · 第 1 页')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查看“SECRE7”的遮盖位置' }));
  view.rerender(<ReviewRegions report={report} keywords={['SECRET', 'SECRE7']} selected="r1" disabled={false} onLocate={locate} />);
  expect(screen.getByText('近似匹配 · 第 1 页')).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

it.each(['constructor', 'toString', '__proto__'])('does not infer an exact match from an inherited object property: %s', word => {
  const report: ReviewReport = { version: 1, pageCount: 1, regions: [{
    id: 'r1', page: 1, origin: 'keyword', keywords: [word], matchKinds: {},
    polygon: [[.1, .1], [.2, .1], [.2, .2], [.1, .2]],
  }] };
  render(<ReviewRegions report={report} keywords={[word]} selected="r1" disabled={false} onLocate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '查看“' + word + '”的遮盖位置' }));
  expect(screen.queryByText('精确匹配 · 第 1 页')).not.toBeInTheDocument();
});
