import { browser, $, expect } from '@wdio/globals';
import { observations } from '../helpers/test-helpers';
import pkg from '../../package.json';

describe('Electron App Launch', () => {
  it('starts the production Main and exposes only the real preload bridge', async () => {
    await $('[data-testid=upload-zone]').waitForDisplayed();
    expect(await browser.execute(() => ({ api: typeof window.electronAPI, require: typeof window.require })))
      .toEqual({ api: 'object', require: 'undefined' });
    expect(await browser.execute(() => window.electronAPI.getAppVersion())).toBe(pkg.version);
  });

  it('owns an isolated real backend and keeps export unavailable before processing', async () => {
    await browser.waitUntil(async () => (await observations()).backendPids.length === 1);
    await browser.waitUntil(async () => (await observations()).readiness.length === 1, { timeout: 60000, timeoutMsg: 'The actual backend did not acknowledge readiness' });
    expect((await observations()).readiness[0]).toMatchObject({ protocol: 1, appVersion: pkg.version });
    expect((await observations()).errors).toEqual([]);
    expect((await observations()).chromiumKeychainMocked).toBe(true);
    expect(await browser.electron.execute((electron) => {
      return electron.app.commandLine.hasSwitch('use-mock-keychain');
    })).toBe(true);
    expect(await $('[data-testid=desensitize-button]').isEnabled()).toBe(false);
    expect(await $('[data-testid=open-export-button]').isEnabled()).toBe(false);
  });
});
