import { beforeAll, afterAll, afterEach } from 'vitest';
import '@testing-library/jest-dom';

// jsdom has no top-layer or focus-containment implementation. This shim only
// exposes dialog state; actual modal keyboard behavior is checked in Electron.
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
}

beforeAll(() => {
  // 全局测试设置
});

afterEach(() => {
  // 每个测试后清理
});

afterAll(() => {
  // 全局测试清理
});
