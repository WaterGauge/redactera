import { browser, $, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { observations, run, selectFile } from '../helpers/test-helpers';
import pkg from '../../package.json';
import { verifyElectronRuntime } from '../support/runtime-identity';

// Read readiness and text in one renderer task; React replaces the text element.
const previewText = () => browser.execute(() => {
  const viewer = document.querySelector('.pdf-viewer');
  if (viewer?.getAttribute('aria-busy') !== 'false') return '';
  return viewer.querySelector('.pdf-page-text pre')?.textContent ?? '';
});

describe('Native startup and preview observations', () => {
  it('starts the actual Main, renderer and owned backend with an isolated keychain', async () => {
    await $('[data-testid=upload-zone]').waitForDisplayed();
    await browser.waitUntil(async () => (await observations()).readiness.length === 1, { timeout: 60000 });
    const observed = await observations();
    expect(observed.backendPids).toHaveLength(1);
    expect(observed.errors).toEqual([]);
    expect(observed.chromiumKeychainMocked).toBe(true);
    await expect($('h1.app-title')).toHaveText(pkg.branding.nameZh);
    expect(await browser.getTitle()).toBe(pkg.branding.nameZh);
    const runtime = await browser.electron.execute(electron => ({
      electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
      platform: process.platform, arch: process.arch, appName: electron.app.getName(), packaged: electron.app.isPackaged,
      windowTitle: electron.BrowserWindow.getAllWindows()[0]?.getTitle(),
      menuLabels: electron.Menu.getApplicationMenu()?.items.map(item => item.label) ?? null,
    }));
    expect(runtime.windowTitle).toBe(pkg.branding.nameZh);
    if (runtime.platform === 'darwin') {
      expect(runtime.menuLabels?.[0]).toBe(pkg.branding.nameZh);
      expect([['文件', '编辑', '显示', '窗口'], ['File', 'Edit', 'View', 'Window']]).toContainEqual(runtime.menuLabels?.slice(1));
    } else if (runtime.platform === 'win32') {
      expect(runtime.menuLabels).toBeNull();
    }
    verifyElectronRuntime(runtime);
    fs.writeFileSync(path.join(run, 'runtime-versions.json'), JSON.stringify(runtime, null, 2));
    if (runtime.packaged) expect(runtime.appName).toBe(pkg.productName);
    expect(await browser.execute(() => typeof window.require)).toBe('undefined');
  });

  it('keeps the known Chinese prefix visible across imports, zoom and page changes', async () => {
    const directory = path.join(run, 'preview-captures'); fs.mkdirSync(directory);
    await browser.execute(() => {
      const state = window as typeof window & { previewDiagnostics?: unknown[] };
      state.previewDiagnostics = [];
      const fetch = window.fetch;
      window.fetch = async (...args) => {
        try { const response = await fetch(...args); state.previewDiagnostics?.push({ fetch: String(args[0]).split(':')[0], status: response.status }); return response; }
        catch (error) { state.previewDiagnostics?.push({ fetch: String(args[0]).split(':')[0], fetchError: error instanceof Error ? error.name : 'UnknownError' }); throw error; }
      };

    });
    const captures = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      if (cycle) {
        await selectFile('sample.pdf');
        await browser.waitUntil(async () => (await previewText()).includes('SECRET'));
      }
      await selectFile('preview.pdf');
      await browser.waitUntil(async () => (await $('.pdf-viewer').getAttribute('aria-busy')) === 'false');
      if ((await $('.pdf-status').getText()).includes('无法预览')) {
        const diagnostics = await browser.execute(() => (window as typeof window & { previewDiagnostics?: unknown[] }).previewDiagnostics);
        fs.writeFileSync(path.join(run, 'preview-load-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
        throw Error('Preview failed to load the verified synthetic fixture');
      }
      if (cycle === 0) {
        const privateSchemeBlocked = await browser.execute(async (file) => {
          try { await fetch(`pdf-safe://${encodeURIComponent(file)}`); return false; }
          catch { return true; }
        }, path.join(run, 'fixtures/preview.pdf'));
        expect(privateSchemeBlocked).toBe(true);
        const unselectedReadBlocked = await browser.execute(async (file) => {
          try { await window.electronAPI.readPdfPreview(file); return false; }
          catch { return true; }
        }, path.join(run, 'fixtures/not-selected.pdf'));
        expect(unselectedReadBlocked).toBe(true);
      }
      for (const zoom of ['1', 'fit']) {
        await $('select[aria-label="预览缩放"]').selectByAttribute('value', zoom);
        await browser.waitUntil(async () => browser.execute((expectedZoom) => {
          const canvas = document.querySelector<HTMLCanvasElement>('.pdf-page-frame canvas');
          const viewport = document.querySelector<HTMLElement>('.pdf-viewport');
          if (!canvas || canvas.hidden || !viewport || document.querySelector('.pdf-viewer')?.getAttribute('aria-busy') !== 'false') return false;
          const expectedWidth = expectedZoom === '1' ? 595 : viewport.clientWidth - 32;
          return Math.abs(canvas.getBoundingClientRect().width - expectedWidth) < 2;
        }, zoom));
        // The details element is closed; WebDriver getText() intentionally
        // returns an empty string for hidden text. Inspect its actual content.
        await browser.waitUntil(async () => (await previewText()).includes('公开信息：复杂页面预览'),
          { timeout: 15000, timeoutMsg: 'Rendered preview text did not match the selected PDF' });
        const name = `cycle-${cycle}-${zoom}`;
        // A preview must remain painted after settling, including with classic
        // scrollbars that change clientWidth when they appear.
        const stability = await browser.executeAsync<Array<{ busy: string | null; width: number; hidden: boolean }>, []>((done) => {
          const samples: Array<{ busy: string | null; width: number; hidden: boolean }> = [];
          const until = performance.now() + 400;
          const sample = () => {
            const viewer = document.querySelector('.pdf-viewer');
            const viewport = document.querySelector<HTMLElement>('.pdf-viewport');
            const canvas = document.querySelector<HTMLCanvasElement>('.pdf-page-frame canvas');
            samples.push({ busy: viewer?.getAttribute('aria-busy') ?? null,
              width: viewport?.clientWidth ?? 0, hidden: !canvas || canvas.hidden });
            if (performance.now() < until) requestAnimationFrame(sample);
            else done(samples);
          };
          requestAnimationFrame(sample);
        });
        fs.writeFileSync(path.join(directory, name + '-stability.json'), JSON.stringify(stability));
        expect(stability.every(sample => sample.busy === 'false' && !sample.hidden)).toBe(true);
        expect(new Set(stability.map(sample => sample.width)).size).toBe(1);
        const data = await browser.execute(() => {
          const canvas = document.querySelector<HTMLCanvasElement>('.pdf-page-frame canvas');
          if (!canvas || canvas.hidden) throw Error('No rendered canvas');
          const rect = canvas.getBoundingClientRect();
          return { image: canvas.toDataURL('image/png').split(',')[1],
            frame: [rect.x, rect.y, rect.width, rect.height], viewport: [window.innerWidth, window.innerHeight] };
        });
        fs.writeFileSync(path.join(directory, name + '-canvas.png'), Buffer.from(data.image, 'base64'));
        fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify({ frame: data.frame, viewport: data.viewport }));
        await browser.saveScreenshot(path.join(directory, name + '-window.png'));
        const checked = spawnSync(process.env.PDF_TEST_PYTHON as string,
          [path.resolve(__dirname, '../support/verify-preview-capture.py'), '--directory', directory, '--name', name], { encoding: 'utf8' });
        fs.writeFileSync(path.join(directory, name + '.log'), checked.stdout + checked.stderr);
        if (checked.error || checked.status !== 0) throw checked.error || Error('Preview capture verification failed: ' + checked.stderr);
        captures.push({ name, ...JSON.parse(checked.stdout) });
      }
      await $('button[aria-label="下一页"]').click();
      await browser.waitUntil(async () => (await previewText()).includes('PUBLIC SECOND PAGE'));
      await $('button[aria-label="上一页"]').click();
      await browser.waitUntil(async () => (await previewText()).includes('公开信息：复杂页面预览'));
    }
    fs.writeFileSync(path.join(run, 'preview-observation.json'), JSON.stringify({ verified: true, captures }, null, 2));
    expect(captures).toHaveLength(6);
  });

  it('reads and navigates a verified 250-page PDF larger than 25 MB', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(run, 'fixtures/preview-manifest.json'), 'utf8')).large;
    expect(manifest.bytes).toBeGreaterThan(25_000_000);
    expect(manifest.pageCount).toBe(250);
    const mainRssBefore = await browser.electron.execute(() => process.memoryUsage().rss);
    const started = Date.now();
    await selectFile('preview-large.pdf');
    await browser.waitUntil(async () => (await previewText()).includes('PUBLIC LARGE PAGE 1'), { timeout: 60000 });
    expect(await $('.pdf-status').getText()).toContain('共 250 页');
    const firstPageMs = Date.now() - started;
    await browser.saveScreenshot(path.join(run, 'large-preview-first.png'));
    await $('input[aria-label="预览页码"]').setValue('250');
    await browser.waitUntil(async () => (await previewText()).includes('PUBLIC LARGE PAGE 250'), { timeout: 60000 });
    expect(await $('.pdf-status').getText()).toContain('第 250 页');
    expect(await $('canvas[aria-label="PDF 第 250 页"]').isDisplayed()).toBe(true);
    await browser.saveScreenshot(path.join(run, 'large-preview-last.png'));
    const mainRssAfter = await browser.electron.execute(() => process.memoryUsage().rss);
    fs.writeFileSync(path.join(run, 'large-preview-observation.json'), JSON.stringify({
      verified: true, ...manifest, firstPageMs, totalMs: Date.now() - started, mainRssBefore, mainRssAfter,
      timingIncludesFixtureAccessCheck: true, coldCacheChecked: false,
    }, null, 2));
  });

});
