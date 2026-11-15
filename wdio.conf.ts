import fs from 'node:fs';
import path from 'node:path';
import { browser } from '@wdio/globals';

const run = process.env.PDF_E2E_RUN;
if (!run) throw new Error('Use npm run test:e2e to build and isolate this test run.');
// Node resolves the installed Electron binary for the host OS/architecture.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const electronBinary: string = process.env.PDF_E2E_APP_BINARY || require('electron');
const results: Array<{ title: string; passed: boolean; durationMs: number; error?: string }> = [];
// The installed WDIO runtime accepts these ChromeDriver parameters; its public
// Config declarations expose only the shared driver fields.
const driverOptions = {
  allowedIps: ['127.0.0.1', '::1'],
  allowedOrigins: ['http://127.0.0.1', 'http://localhost'],
  logPath: path.join(run, 'chromedriver.log'),
};

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: process.env.PDF_E2E_SUITE === 'readiness' ? [path.join(__dirname, 'e2e/tests/readiness.spec.ts')]
    : process.env.PDF_E2E_SUITE === 'native-dialogs' ? [[path.join(__dirname, 'e2e/tests/basic-workflow.spec.ts'), path.join(__dirname, 'e2e/tests/native-dialogs.spec.ts')]]
    : [[path.join(__dirname, 'e2e/tests/basic-workflow.spec.ts'), path.join(__dirname, 'e2e/tests/complete-workflow.spec.ts')]],
  exclude: [],
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'electron',
      'wdio:electronServiceOptions': {
        appBinaryPath: electronBinary,
        // Set this before native Chromium initialization, rather than relying
        // on ChromeDriver's implicit defaults or the later JS bootstrap.
        appArgs: ['--use-mock-keychain', '--disable-features=UseKeychainKeyProvider',
          ...(process.env.PDF_E2E_APP_BINARY ? [] : [`--app=${path.join(run, 'app')}`])],
      },
      'goog:chromeOptions': { args: [`--user-data-dir=${path.join(run, 'profile')}`], detach: true },
      'wdio:chromedriverOptions': driverOptions,
    },
  ],
  logLevel: 'error',
  bail: 1,
  waitforTimeout: 20000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 0,
  services: ['electron'],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: process.env.PDF_E2E_SUITE === 'native-dialogs' ? 300000 : 90000,
    bail: true,
  },
  afterTest: async (test, context, result) => {
    void context;
    results.push({ title: test.title, passed: result.passed, durationMs: result.duration, error: result.error?.message });
    if (!result.passed) await browser.saveScreenshot(path.join(run, `failure-${results.length}.png`)).catch(() => undefined);
  },
  after: () => {
    fs.writeFileSync(path.join(run, 'test-results.json'), JSON.stringify({ runId: process.env.PDF_E2E_RUN_ID,
      passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length,
      skipped: 0, tests: results }, null, 2));
    // Let WebDriver close its own window/session. The test host quits on the
    // actual window-all-closed event; the runner independently verifies shutdown.
  },
};
