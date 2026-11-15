import { browser, $ } from '@wdio/globals';
import * as path from 'path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

export const run = process.env.PDF_E2E_RUN as string;
interface Host {
  open(name: string): void;
  save(name: string | null, delay?: number): void;
  observations(): { errors: string[]; chromiumKeychainMocked: boolean; nativeDialogsReplaced: boolean;
    nativeDialogEvents: Array<{ kind: string; canceled: boolean; expectedPath: boolean }>;
    revealedExports: string[]; fileRevealReplaced: boolean; saveDialogs: { started: number; finished: number }; backendPids: number[]; readiness: Array<{ protocol: number; appVersion: string; elapsedMs: number }>; requests: Array<{ action: string; format?: string; dpi?: number; outputPath?: string; review?: { version: number; pageCount: number; regions: number } }> };
}

export async function waitForElement(selector: string, timeout = 10000) {
  const element = await $(selector);
  await element.waitForDisplayed({ timeout });
  return element;
}

export async function waitForText(selector: string, text: string, timeout = 10000) {
  const element = await $(selector);
  await browser.waitUntil(
    async () => {
      const elementText = await element.getText();
      return elementText.includes(text);
    },
    { timeout, timeoutMsg: `Element ${selector} did not contain text "${text}"` }
  );
  return element;
}

export function getTestPDFPath(filename: string): string {
  return path.join(run, 'fixtures', filename);
}

export async function selectFile(name: string) {
  const expected = crypto.createHash('sha256').update(fs.readFileSync(getTestPDFPath(name))).digest('hex');
  const access = await browser.electron.execute((_electron, file) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nativeFs = require('node:fs') as typeof import('node:fs');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nativeCrypto = require('node:crypto') as typeof import('node:crypto');
      return { sha256: nativeCrypto.createHash('sha256').update(nativeFs.readFileSync(file)).digest('hex') };
    } catch (error) { return { error: (error as NodeJS.ErrnoException).code ?? String(error) }; }
  }, getTestPDFPath(name));
  fs.appendFileSync(path.join(run, 'fixture-app-access.log'), JSON.stringify(access) + '\n');
  if (access.sha256 !== expected) throw new Error(`The app cannot read the supplied synthetic fixture: ${JSON.stringify(access)}`);
  await browser.electron.execute((_electron, value) => {
    (globalThis as typeof globalThis & { __pdfE2E: Host }).__pdfE2E.open(value);
  }, name);
  await $('[data-testid=upload-zone]').click();
  await browser.waitUntil(async () => (await $('[data-testid=file-name]').getText()) === name);
}

export function observations() {
  return browser.electron.execute(() => (globalThis as typeof globalThis & { __pdfE2E: Host }).__pdfE2E.observations());
}

export async function addKeyword(word: string) {
  const input = $('[data-testid=keyword-input]');
  const text = await input.getValue();
  await input.setValue([text, word].filter(Boolean).join('\n'));
}

export async function processFile() {
  await $('[data-testid=desensitize-button]').click();
  await $('.result-summary').waitForDisplayed();
  await $('[data-testid=open-export-button]').waitForEnabled();
  await browser.waitUntil(async () => (await $('.pdf-viewer').getAttribute('aria-busy')) === 'false');
}

export async function exportFile(name: string, format: 'pdf' | 'png_zip', dpi = 300, delay = 0) {
  await browser.electron.execute((_electron, value, milliseconds) => {
    (globalThis as typeof globalThis & { __pdfE2E: Host }).__pdfE2E.save(value, milliseconds);
  }, name, delay);
  if (format === 'pdf') await $('[data-testid=open-export-button]').click();
  else {
    await $('summary[aria-label="其他导出格式"]').click();
    await $('[data-testid=open-image-export-button]').click();
    await $('dialog.export-dialog').waitForDisplayed();
    await $(`input[name=image-export-dpi][value="${dpi}"]`).click();
    await $('.export-dialog .btn-drawer-save').click();
  }
  if (!delay) {
    await browser.waitUntil(() => fs.existsSync(path.join(run, 'exports', name)));
    await $('[data-testid=open-export-button]').waitForEnabled();
  }
}

export function verifyOutput(name: string, sample: string, kind: 'pdf' | 'png_zip', dpi = 300, reference = 'sample.pdf') {
  const args = [path.resolve(__dirname, '../support/verify-output.py'), '--fixtures', path.join(run, 'fixtures'),
    '--output', path.join(run, 'exports', name), '--sample', sample, '--kind', kind, '--dpi', String(dpi)];
  if (kind === 'png_zip') args.push('--reference-pdf', path.join(run, 'exports', reference));
  const result = spawnSync(process.env.PDF_TEST_PYTHON as string, args, { encoding: 'utf8' });
  fs.writeFileSync(path.join(run, `verified-${name}.log`), result.stdout + result.stderr);
  if (result.error || result.status !== 0) throw result.error || new Error(`Export content verification failed: ${name}\n${result.stderr}`);
}
