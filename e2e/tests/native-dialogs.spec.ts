import { browser, $, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { addKeyword, exportFile, observations, processFile, run, verifyOutput } from '../helpers/test-helpers';

describe('Interactive macOS file panels', () => {
  it('imports and exports through actual OS panels and verifies the saved PDF', async () => {
    expect((await observations()).nativeDialogsReplaced).toBe(false);
    const identity = process.env.PDF_E2E_RUN_ID as string;
    fs.writeFileSync(path.join(run, 'native-ui-awaiting.json'), JSON.stringify({ runId: identity }));
    await browser.waitUntil(() => {
      const file = path.join(run, 'native-ui-connected');
      return fs.existsSync(file) && fs.readFileSync(file, 'utf8') === identity;
    }, { timeout: 90000 });
    await $('[data-testid=upload-zone]').click();
    await browser.waitUntil(async () => (await $('[data-testid=file-name]').getText()) === 'sample.pdf', { timeout: 240000 });
    await browser.waitUntil(async () => String(await $('.pdf-page-text pre').getProperty('textContent')).includes('SECRET'));
    await addKeyword('SECRET'); await addKeyword('张三'); await processFile();
    // The external UI driver needs time to accept the native save panel.
    // Skip the normal helper's short automatic-dialog completion wait.
    await exportFile('native-result.pdf', 'pdf', 300, 1);
    await browser.waitUntil(() => fs.existsSync(path.join(run, 'exports/native-result.pdf')), { timeout: 240000 });
    verifyOutput('native-result.pdf', 'sample.pdf', 'pdf');
    expect((await observations()).nativeDialogEvents).toEqual([
      { kind: 'open', canceled: false, expectedPath: true },
      { kind: 'save', canceled: false, expectedPath: true },
    ]);
  });
});
