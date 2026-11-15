import { browser, $, $$, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { addKeyword, exportFile, getTestPDFPath, observations, processFile, run, selectFile, verifyOutput } from '../helpers/test-helpers';

describe('Complete PDF Desensitization Workflow', () => {
  it('imports multiline terms and exports a real complete PDF without reviewing every page', async () => {
    await selectFile('sample.pdf');
    await browser.waitUntil(async () => String(await $('.pdf-page-text pre').getProperty('textContent')).includes('SECRET'));
    await $('[data-testid=keyword-input]').setValue('SECRET\n张三');
    expect((await observations()).requests.filter(item => item.action === 'desensitize')).toHaveLength(0);
    await exportFile('sample.pdf', 'pdf');
    verifyOutput('sample.pdf', 'sample.pdf', 'pdf');
    const record = (await observations()).requests.find(item => item.action === 'desensitize');
    expect(record?.review).toEqual({ version: 1, pageCount: 2, regions: 2 });
    expect(await $$('input[type=checkbox]')).toHaveLength(0);
    expect(await $('input[aria-label="预览页码"]').getValue()).toBe('1');
    expect(fs.readFileSync(path.join(run, 'exports/sample.pdf'))).toEqual(fs.readFileSync(record?.outputPath as string));
  });

  it('presents newly found uncertainty once and exports after one explicit decision', async () => {
    await addKeyword('MISSING');
    const saves = (await observations()).saveDialogs.started;
    await $('[data-testid=open-export-button]').click();
    await $('.pending-export').waitForDisplayed();
    await $('[data-testid=open-export-button]').waitForEnabled();
    expect((await observations()).saveDialogs.started).toBe(saves);
    expect(await $$('input[type=checkbox]')).toHaveLength(0);
    await browser.electron.execute((_electron, name) => {
      (globalThis as typeof globalThis & { __pdfE2E: { save(name: string): void } }).__pdfE2E.save(name);
    }, 'warnings.pdf');
    await $('button=仍然导出 PDF').click();
    await browser.waitUntil(() => fs.existsSync(path.join(run, 'exports/warnings.pdf')));
    verifyOutput('warnings.pdf', 'sample.pdf', 'pdf');
  });

  it('exports actual PNG ZIP pixels at selected DPI without repeating recognition or confirmation', async () => {
    const before = (await observations()).requests.filter(item => item.action === 'desensitize').length;
    await exportFile('pages300.zip', 'png_zip', 300);
    verifyOutput('pages300.zip', 'sample.pdf', 'png_zip', 300);
    const records = (await observations()).requests;
    expect(records.filter(item => item.action === 'desensitize')).toHaveLength(before);
    expect(records.find(item => item.action === 'export')).toMatchObject({ format: 'png_zip', dpi: 300 });
  });

  it('does not revive a waiting native save after terms change and return to their previous values', async () => {
    const finished = (await observations()).saveDialogs.finished;
    await exportFile('withdrawn.pdf', 'pdf', 300, 1500);
    await $('[data-testid=keyword-input]').setValue('SECRET\n张三\nMISSING\nNEW');
    await $('[data-testid=keyword-input]').setValue('SECRET\n张三\nMISSING');
    await browser.waitUntil(async () => (await observations()).saveDialogs.finished > finished);
    expect(fs.existsSync(path.join(run, 'exports/withdrawn.pdf'))).toBe(false);
    expect(await $('.result-summary').isExisting()).toBe(false);
  });

  it('reports an actual malformed-PDF failure without saving an incomplete or stale result', async () => {
    fs.writeFileSync(getTestPDFPath('broken.pdf'), '%PDF-1.7 synthetic malformed fixture');
    await selectFile('broken.pdf');
    await browser.waitUntil(async () => (await $('.pdf-status').getText()).includes('无法预览'));
    const saves = (await observations()).saveDialogs.started;
    await $('[data-testid=open-export-button]').click();
    await browser.waitUntil(async () => (await $('[data-testid=status-bar]').getText()).startsWith('错误'));
    expect(await $('[data-testid=status-bar]').getText()).toContain('无法打开这份 PDF');
    expect(await $('[data-testid=status-bar]').getText()).not.toContain('Error invoking remote method');
    expect(await $('.result-summary').isExisting()).toBe(false);
    expect((await observations()).saveDialogs.started).toBe(saves);
  });

  it('recovers and removes both pieces of an actual cross-line target', async () => {
    await selectFile('crossline-sample.pdf');
    await $('.clear-all-btn').click(); await addKeyword('SECRET');
    await processFile();
    expect(await $('[data-testid=processing-warnings]').getText()).toContain('跨行匹配');
    await exportFile('crossline.pdf', 'pdf');
    verifyOutput('crossline.pdf', 'crossline-sample.pdf', 'pdf');
  });

  it('uses real OCR to remove English and Chinese pixels from an image-only PDF', async () => {
    await selectFile('scanned.pdf');
    await $('.clear-all-btn').click(); await addKeyword('SECRET'); await addKeyword('张三');
    await processFile();
    const records = (await observations()).requests.filter(item => item.action === 'desensitize');
    expect(records.at(-1)?.review).toEqual({ version: 1, pageCount: 2, regions: 2 });
    await exportFile('scanned.pdf', 'pdf');
    verifyOutput('scanned.pdf', 'scanned.pdf', 'pdf');
  });

  it('exports the verified OCR result as actual 300 DPI PNG pixels', async () => {
    const before = (await observations()).requests.filter(item => item.action === 'desensitize').length;
    await exportFile('scanned-pages300.zip', 'png_zip', 300);
    verifyOutput('scanned-pages300.zip', 'scanned.pdf', 'png_zip', 300, 'scanned.pdf');
    expect((await observations()).requests.filter(item => item.action === 'desensitize')).toHaveLength(before);
  });

  it('removes native text and actual OCR image text from the same mixed page', async () => {
    await selectFile('mixed.pdf');
    await $('.clear-all-btn').click(); await addKeyword('TEXTSECRET'); await addKeyword('IMAGESECRET');
    await processFile();
    const records = (await observations()).requests.filter(item => item.action === 'desensitize');
    expect(records.at(-1)?.review).toEqual({ version: 1, pageCount: 1, regions: 2 });
    await exportFile('mixed.pdf', 'pdf');
    verifyOutput('mixed.pdf', 'mixed.pdf', 'pdf');
    await $('button=打开文件位置').click();
    await browser.waitUntil(async () => (await observations()).revealedExports.includes('mixed.pdf'));
    expect((await observations()).fileRevealReplaced).toBe(true);
  });

  it('saves motion preference without processing again and keeps the complete desktop layout usable', async () => {
    const before = (await observations()).requests.filter(item => item.action === 'desensitize').length;
    const directory = path.join(run, 'workflow-captures'); fs.mkdirSync(directory);
    await $('button=设置').click();
    const motion = await browser.execute(() => {
      const dialog = document.querySelector('dialog');
      return dialog && { name: getComputedStyle(dialog).animationName, duration: getComputedStyle(dialog).animationDuration, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches };
    });
    expect(motion).toEqual(motion?.reduced ? { name: 'none', duration: '0s', reduced: true } : { name: 'panel-enter', duration: '0.24s', reduced: false });
    await $('#ui-motion').selectByAttribute('value', 'off');
    await $('button=保存').click();
    await $('dialog.drawer').waitForExist({ reverse: true });
    const preference = await browser.execute(() => ({ motion: document.querySelector('.app')?.getAttribute('data-motion'),
      transition: getComputedStyle(document.querySelector('[data-testid=open-export-button]') as HTMLElement).transitionDuration,
      stored: localStorage.getItem('pdf.ui.motion') }));
    expect(preference).toEqual({ motion: 'off', transition: '0s', stored: 'off' });
    const resize = async (width: number, height: number) => {
      const size = await browser.electron.execute((electron, w, h) => {
        const window = electron.BrowserWindow.getAllWindows()[0];
        if (!window || window.isDestroyed()) throw Error('Missing owned test window');
        window.setSize(w, h);
        return window.getContentSize();
      }, width, height);
      await browser.waitUntil(async () => browser.execute(expected => innerWidth === expected[0] && innerHeight === expected[1], size));
      await browser.waitUntil(async () => (await $('.pdf-viewer').getAttribute('aria-busy')) === 'false');
    };
    await resize(1024, 720);
    await browser.saveScreenshot(path.join(directory, 'desktop-1024.png'));
    const layout = await browser.execute(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
      exportTop: (document.querySelector('[data-testid=open-export-button]') as HTMLElement).getBoundingClientRect().top,
      viewport: [innerWidth, innerHeight] }));
    expect(layout.overflow).toBe(false); expect(layout.exportTop).toBeLessThan(150);
    await resize(1440, 900);
    await browser.saveScreenshot(path.join(directory, 'desktop-1440.png'));
    for (const filter of ['grayscale(1)', 'blur(3px)']) {
      await browser.execute(value => { (document.querySelector('.app') as HTMLElement).style.filter = value; }, filter);
      await browser.saveScreenshot(path.join(directory, filter.startsWith('gray') ? 'desktop-grayscale.png' : 'desktop-blur.png'));
    }
    await browser.execute(() => { (document.querySelector('.app') as HTMLElement).style.removeProperty('filter'); });

    fs.writeFileSync(path.join(directory, 'motion-layout.json'), JSON.stringify({ motion, preference, layout }, null, 2));
    expect((await observations()).requests.filter(item => item.action === 'desensitize')).toHaveLength(before);
  });
  it('keeps an all-zero match distinct from successful keyword redaction and saves only on an explicit copy action', async () => {
    await selectFile('sample.pdf');
    await $('[data-testid=keyword-input]').setValue('MISSING_ONLY');
    const saves = (await observations()).saveDialogs.started;
    await $('[data-testid=open-export-button]').click();
    await $('.pending-export').waitForDisplayed();
    await $('[data-testid=open-export-button]').waitForEnabled();
    expect((await observations()).saveDialogs.started).toBe(saves);
    expect(await $('.result-summary h2').getText()).toBe('未找到要打码的文字');
    await browser.electron.execute((_electron, name) => {
      (globalThis as typeof globalThis & { __pdfE2E: { save(name: string): void } }).__pdfE2E.save(name);
    }, 'no-match-copy.pdf');
    await $('.pending-export').$('button=另存为副本').click();
    await browser.waitUntil(() => fs.existsSync(path.join(run, 'exports/no-match-copy.pdf')));
    const verification = spawnSync(process.env.PDF_TEST_PYTHON as string, ['-c',
      'import pymupdf as fitz,sys,json; d=fitz.open(sys.argv[1]); text="".join(p.get_text() for p in d); assert d.page_count==2 and "SECRET" in text and "张三" in text; assert not d.embfile_count() and not d.get_toc(); print(json.dumps({"pages":d.page_count,"unmatched_content_retained":True}))',
      path.join(run, 'exports/no-match-copy.pdf')], { encoding: 'utf8' });
    fs.writeFileSync(path.join(run, 'verified-no-match-copy.log'), verification.stdout + verification.stderr);
    expect(verification.status).toBe(0);
  });

  it('imports a real native File above the virtual-file limit through the actual isolated preload', async () => {
    const generated = spawnSync(process.env.PDF_TEST_PYTHON as string, [
      path.resolve(__dirname, '../fixtures/preview-fixture.py'), '--directory', path.join(run, 'fixtures'),
    ], { encoding: 'utf8', timeout: 120000 });
    fs.writeFileSync(path.join(run, 'drop-fixture-generation.log'), generated.stdout + generated.stderr);
    expect(generated.status).toBe(0);
    const nativeSource = getTestPDFPath('拖入 # +.pdf');
    fs.copyFileSync(getTestPDFPath('preview-large.pdf'), nativeSource);
    const original = fs.readFileSync(nativeSource);
    expect(original.length).toBeGreaterThan(16 * 1024 * 1024);
    await browser.execute(() => {
      const input = document.createElement('input');
      input.type = 'file'; input.id = 'e2e-real-drop';
      input.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;';
      document.body.append(input);
    });
    try {
      await $('#e2e-real-drop').setValue(nativeSource);
      const proof = await browser.execute(async source => {
        const file = (document.querySelector('#e2e-real-drop') as HTMLInputElement).files?.[0];
        if (!file) throw Error('No native File selected');
        const saved = await window.electronAPI.importDroppedFile(file);
        if (!saved) throw Error('Native import failed');
        let sourceDenied = false;
        try { await window.electronAPI.readPdfPreview(source); } catch { sourceDenied = true; }
        const transferred = new DataTransfer(); transferred.items.add(file);
        const zone = document.querySelector('[data-testid=upload-zone]');
        if (!zone) throw Error('Missing import area');
        zone.dispatchEvent(new DragEvent('drop', {
          bubbles: true, cancelable: true, dataTransfer: transferred,
        }));
        return { saved, sourceDenied, nativeBytes: file.size,
          rawPathApiExposed: typeof (window.electronAPI as unknown as Record<string, unknown>).getPathForFile !== 'undefined',
          oldArrayApiExposed: typeof (window.electronAPI as unknown as Record<string, unknown>).saveDraggedFile !== 'undefined' };
      }, nativeSource);
      expect(proof.saved).toBeTruthy();
      expect(proof.sourceDenied).toBe(true);
      expect(proof.rawPathApiExposed).toBe(false);
      expect(proof.oldArrayApiExposed).toBe(false);
      // Resolve Windows 8.3 aliases before checking directory membership.
      const owned = fs.realpathSync.native(path.join(run, 'profile/file-sessions'));
      const imported = fs.realpathSync.native(proof.saved);
      const relative = path.relative(owned, imported);
      expect(relative).not.toBe('');
      expect(relative.split(path.sep, 1)[0]).not.toBe('..');
      expect(path.isAbsolute(relative)).toBe(false);
      expect(fs.readFileSync(imported).equals(original)).toBe(true);
      expect(fs.readFileSync(nativeSource).equals(original)).toBe(true);
      await browser.waitUntil(async () => (await $('[data-testid=file-name]').getText()) === '拖入 # +.pdf');
      await browser.waitUntil(async () => (await $('.pdf-viewer').getAttribute('aria-busy')) === 'false');
      expect(await $('input[aria-label="预览页码"]').getAttribute('max')).toBe('250');
      fs.writeFileSync(path.join(run, 'native-drop-proof.json'), JSON.stringify(proof, null, 2));
    } finally {
      await browser.execute(() => document.querySelector('#e2e-real-drop')?.remove());
    }
  });

  it('rejects a forged path object and supports virtual File import through real bridge and export', async () => {
    const encoded = fs.readFileSync(getTestPDFPath('sample.pdf')).toString('base64');
    const proof = await browser.execute(async data => {
      const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
      const file = new File([bytes], 'virtual.pdf', { type: 'application/pdf' });
      const forged = await window.electronAPI.importDroppedFile({
        name: 'fake.pdf', size: bytes.length, path: '/synthetic/unselected.pdf',
      } as unknown as File);
      const saved = await window.electronAPI.importDroppedFile(file);
      if (!saved) throw Error('Virtual import failed');
      const transfer = new DataTransfer(); transfer.items.add(file);
      const zone = document.querySelector('[data-testid=upload-zone]');
      if (!zone) throw Error('Missing import area');
      zone.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
      }));
      return { forged, saved, bytes: bytes.length };
    }, encoded);
    expect(proof.forged).toBeNull();
    expect(proof.saved).toBeTruthy();
    expect(fs.readFileSync(proof.saved).toString('base64')).toBe(encoded);
    await browser.waitUntil(async () => (await $('[data-testid=file-name]').getText()) === 'virtual.pdf');
    await $('[data-testid=keyword-input]').setValue('SECRET\n张三');
    await exportFile('virtual-drop.pdf', 'pdf');
    verifyOutput('virtual-drop.pdf', 'sample.pdf', 'pdf');
    expect(await $$('input[type=checkbox]')).toHaveLength(0);
    fs.writeFileSync(path.join(run, 'virtual-drop-proof.json'), JSON.stringify(proof, null, 2));
  });


  it('shows exact and approximate positions from actual final masks without blocking direct export', async () => {
    const source = getTestPDFPath('fuzzy.pdf');
    const generated = spawnSync(process.env.PDF_TEST_PYTHON as string, ['-c',
      'import pymupdf as fitz,sys; d=fitz.open(); p=d.new_page(); p.insert_text((40,70),"SECRET"); p.insert_text((40,110),"SECRE7"); p.insert_text((40,250),"PUBLIC"); d.save(sys.argv[1])', source],
      { encoding: 'utf8' });
    expect(generated.status).toBe(0);
    const original = fs.readFileSync(source);
    await selectFile('fuzzy.pdf');
    await $('button=设置').click();
    const fuzzy = await $('label*=匹配相似文字').$('input[type=checkbox]');
    if (!(await fuzzy.isSelected())) await fuzzy.click();
    await $('button=保存').click();
    await $('dialog.drawer').waitForExist({ reverse: true });
    await $('[data-testid=keyword-input]').setValue('SECRET');
    await processFile();
    const word = await $('button[aria-label="查看“SECRET”的遮盖位置"]');
    expect(await word.getText()).toContain('近似 1 处');
    await word.click();
    await browser.waitUntil(async () => (await $('.result-summary').getText()).includes('精确匹配 · 第 1 页'));
    await $('button[aria-label="下一处遮盖"]').click();
    await browser.waitUntil(async () => (await $('.result-summary').getText()).includes('近似匹配 · 第 1 页'));
    await exportFile('fuzzy-output.pdf', 'pdf');
    const verified = spawnSync(process.env.PDF_TEST_PYTHON as string, ['-c',
      'import pymupdf as fitz,sys,json; d=fitz.open(sys.argv[1]); t="".join(p.get_text() for p in d); assert "SECRET" not in t and "SECRE7" not in t and "PUBLIC" in t; print(json.dumps({"both_targets_removed":True,"public_preserved":True}))',
      path.join(run, 'exports/fuzzy-output.pdf')], { encoding: 'utf8' });
    fs.writeFileSync(path.join(run, 'verified-fuzzy-output.log'), verified.stdout + verified.stderr);
    expect(verified.status).toBe(0);
    expect(fs.readFileSync(source)).toEqual(original);
    expect(await $$('input[type=checkbox]')).toHaveLength(0);
  });


  it('checks both appearances of the same keyword when one is drawn as an outline', async () => {
    const source = getTestPDFPath('outline-text.pdf');
    const python = process.env.PDF_TEST_PYTHON as string;
    const fixture = path.resolve(__dirname, '../fixtures/outline-fixture.py');
    const generated = spawnSync(python, [fixture, source], { encoding: 'utf8', timeout: 30000 });
    expect(generated.status).toBe(0);
    const original = fs.readFileSync(source);
    await selectFile('outline-text.pdf');
    await $('[data-testid=keyword-input]').setValue('SECRET');
    const saves = (await observations()).saveDialogs.started;
    await $('[data-testid=open-export-button]').click();
    await $('.pending-export').waitForDisplayed();
    const warning = await $('[data-testid=processing-warnings]');
    expect(await warning.getText()).toContain('请核对轮廓文字');
    expect(await warning.$('button[aria-label="查看第 1 页"]').isExisting()).toBe(true);
    expect((await observations()).saveDialogs.started).toBe(saves);
    const last = (await observations()).requests.filter(item => item.action === 'desensitize').at(-1);
    expect(last?.review).toEqual({ version: 1, pageCount: 1, regions: 2 });
    await browser.electron.execute((_electron, name) => {
      (globalThis as typeof globalThis & { __pdfE2E: { save(name: string): void } }).__pdfE2E.save(name);
    }, 'outline-output.pdf');
    await $('button=仍然导出 PDF').click();
    const exported = path.join(run, 'exports/outline-output.pdf');
    await browser.waitUntil(() => fs.existsSync(exported));
    const verified = spawnSync(python, [fixture, source, '--output', exported], { encoding: 'utf8', timeout: 30000 });
    fs.writeFileSync(path.join(run, 'verified-outline-output.log'), verified.stdout + verified.stderr);
    expect(verified.status).toBe(0);
    expect(fs.readFileSync(source)).toEqual(original);
  });
});
