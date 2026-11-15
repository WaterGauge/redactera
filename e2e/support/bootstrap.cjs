// Test host only. Loads the actual production Main entry after isolating OS
// boundaries. No processing, authorization, copy, or shutdown handler is faked.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const electron = require('electron');
const { app, dialog, ipcMain, safeStorage, session } = electron;
// Newer Chromium has a separate asynchronous macOS key provider. Disable it
// at process launch in tests as well as mocking the legacy synchronous API.
const asyncKeychainDisabled = app.commandLine.getSwitchValue('disable-features').split(',').includes('UseKeychainKeyProvider');
if (process.platform === 'darwin' && !asyncKeychainDisabled) throw Error('Isolated E2E keychain launch flags are required');
// WDIO 9's Main bridge expects CommonJS globals, which a bundled ASAR entry
// does not expose to CDP. Only this explicit test entry supplies native require.
const nativeRequire = typeof __non_webpack_require__ === 'function' ? __non_webpack_require__ : require;
globalThis.require = nativeRequire;

const run = process.env.PDF_E2E_RUN;
const root = process.env.PDF_E2E_ROOT;
const python = process.env.PDF_TEST_PYTHON;
if (![run, root, python].every(value => value && path.isAbsolute(value))) throw Error('Missing isolated E2E configuration');
const profile = path.join(run, 'profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
if (!app.isPackaged) app.getAppPath = () => root;
app.commandLine.appendSwitch('disable-background-networking');
// Chromium cookie encryption shares the macOS keychain even when the JS
// safeStorage methods below are replaced. Keep all E2E crypto synthetic.
app.commandLine.appendSwitch('use-mock-keychain');
app.on('window-all-closed', () => app.quit());
const quitTimer = setInterval(() => {
  const request = path.join(run, 'request-quit');
  if (fs.existsSync(request) && fs.readFileSync(request, 'utf8') === process.env.PDF_E2E_RUN_ID) app.quit();
}, 100);
quitTimer.unref();
const nativeDialogs = process.env.PDF_E2E_NATIVE_DIALOGS === 'true';
const observed = { revealedExports: [], fileRevealReplaced: true, saveDialogs: { started: 0, finished: 0 }, requests: [], backendPids: [], readiness: [], nativeDialogsReplaced: !nativeDialogs, nativeDialogEvents: [], safeStorageReplaced: true, chromiumKeychainMocked: true,
  chromiumAsyncKeychainDisabled: asyncKeychainDisabled,
  sourceInterpreterReplaced: false, electronPid: process.pid, parentDriverPid: process.ppid, errors: [] };
const persist = () => fs.writeFileSync(path.join(run, 'host-observations.json'), JSON.stringify(observed, null, 2));
electron.shell.showItemInFolder = file => {
  // Windows can spell the same parent with either its 8.3 alias or long name.
  const resolved = fs.realpathSync.native(file);
  if (path.dirname(resolved) !== fs.realpathSync.native(path.join(run, 'exports')) || !fs.statSync(resolved).isFile()) throw Error('Invalid E2E reveal destination');
  observed.revealedExports.push(path.basename(resolved)); persist();
};
let nextOpen, nextSave, saveDelay = 0;
const realOpenDialog = dialog.showOpenDialog.bind(dialog);
const realSaveDialog = dialog.showSaveDialog.bind(dialog);
globalThis.__pdfE2E = {
  open(name) {
    if (path.basename(name) !== name) throw Error('Invalid fixture name');
    nextOpen = path.join(run, 'fixtures', name);
    if (!fs.statSync(nextOpen).isFile()) throw Error('Missing fixture');
  },
  save(name, delay = 0) {
    if (name !== null && path.basename(name) !== name) throw Error('Invalid export name');
    nextSave = name === null ? undefined : path.join(run, 'exports', name);
    saveDelay = delay;
  },
  observations: () => observed,
};
dialog.showOpenDialog = async () => {
  const selected = nextOpen; nextOpen = undefined;
  return { canceled: !selected, filePaths: selected ? [selected] : [] };
};
dialog.showSaveDialog = async () => {
  observed.saveDialogs.started++; persist();
  const target = nextSave, delay = saveDelay; nextSave = undefined; saveDelay = 0;
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  observed.saveDialogs.finished++; persist();
  return { canceled: !target, filePath: target };
};
if (nativeDialogs) {
  // Actual OS panels, with public fixture defaults. Reject any accidental
  // selection outside this run before production handlers can read or write.
  const requestFile = path.join(run, 'native-dialog-request.json');
  const announce = (kind, expectedPath, completed = false) => fs.writeFileSync(requestFile,
    JSON.stringify({ runId: process.env.PDF_E2E_RUN_ID, kind, expectedPath, completed }));
  const matchesPath = (selected, expected, existing) => {
    try {
      const actual = existing ? fs.realpathSync(selected)
        : path.join(fs.realpathSync(path.dirname(selected)), path.basename(selected));
      return actual === expected;
    } catch { return false; }
  };
  dialog.showOpenDialog = async (window, options) => {
    const expectedPath = path.join(run, 'fixtures/sample.pdf'); announce('open', expectedPath);
    const result = await realOpenDialog(window, { ...options, defaultPath: expectedPath });
    const expected = !result.canceled && result.filePaths.length === 1 && matchesPath(result.filePaths[0], expectedPath, true);
    observed.nativeDialogEvents.push({ kind: 'open', canceled: result.canceled, expectedPath: expected }); persist();
    announce('open', expectedPath, true);
    return expected ? result : { canceled: true, filePaths: [] };
  };
  dialog.showSaveDialog = async (window, options) => {
    const expectedPath = path.join(run, 'exports/native-result.pdf'); announce('save', expectedPath);
    const result = await realSaveDialog(window, { ...options, defaultPath: expectedPath });
    const expected = !result.canceled && result.filePath && matchesPath(result.filePath, expectedPath, false);
    observed.nativeDialogEvents.push({ kind: 'save', canceled: result.canceled, expectedPath: !!expected }); persist();
    announce('save', expectedPath, true);
    return expected ? result : { canceled: true };
  };
}
dialog.showErrorBox = () => { observed.errors.push('startup-error-box'); persist(); };
dialog.showMessageBox = async () => { observed.errors.push('unexpected-message-box'); persist(); return { response: 0, checkboxChecked: false }; };
safeStorage.isEncryptionAvailable = () => false;
safeStorage.encryptString = safeStorage.decryptString = () => { throw Error('Real credentials forbidden in E2E'); };

// Observe the real source launcher; the manager selects its documented
// PDF_DESENSITIZATION_PYTHON override without a spawn substitution.
const spawn = cp.spawn;
cp.spawn = (command, args, options) => {
  const backend = app.isPackaged
    ? command === path.join(process.resourcesPath, 'dist', process.platform === 'win32' ? 'python_backend.exe' : 'python_backend')
    : command === python && args?.[0] === path.join(root, 'python-backend', 'main.py');
  if (backend) {
    const started = Date.now();
    const child = spawn(command, args, options);
    if (child.pid) observed.backendPids.push(child.pid);
    let buffer = '';
    child.stdout?.on('data', data => {
      buffer += data.toString();
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value.type === 'ready') { observed.readiness.push({ elapsedMs: Date.now() - started, protocol: value.protocol, appVersion: value.appVersion, sourceSha256: value.sourceSha256 }); persist(); }
        } catch { /* Actual manager validates the protocol; this only observes readiness. */ }
      }
    });
    persist(); return child;
  }
  return spawn(command, args, options);
};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
  if (channel !== 'pdf:process') return listener(event, ...args);
  const record = { action: args[0]?.action, format: args[0]?.payload?.format, dpi: args[0]?.payload?.dpi,
    inputPath: args[0]?.payload?.file_path };
  observed.requests.push(record); persist();
  const result = await listener(event, ...args);
  const negative = process.env.PDF_E2E_NEGATIVE_CONTROL;
  if (record.action === 'desensitize' && (negative === 'unredacted-result' ||
      negative === 'ocr-overlay' && path.basename(record.inputPath) === 'scanned.pdf')) {
    // Deliberate test mutation: replacing only this run's retained result with
    // its synthetic original must make the real UI/artifact assertions fail.
    if (!result.output_path.startsWith(path.join(profile, 'file-sessions') + path.sep) ||
        !args[0].payload.file_path.startsWith(path.join(run, 'fixtures') + path.sep)) throw Error('Unsafe negative control path');
    if (negative === 'unredacted-result') fs.copyFileSync(args[0].payload.file_path, result.output_path);
    else {
      const helper = path.join(run, 'unsafe-overlay.py');
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex');
      if (sha256 !== process.env.PDF_E2E_OVERLAY_HELPER_SHA256) throw Error('Overlay helper identity mismatch');
      record.negativeControl = { kind: negative, helperSha256: sha256, created: false };
      // The external test runner owns its host Python dependencies. A packaged
      // app must not need access to the developer's protected source/venv.
      const request = path.join(run, 'overlay-request.json');
      fs.writeFileSync(request + '.tmp', JSON.stringify({ runId: process.env.PDF_E2E_RUN_ID,
        inputPath: record.inputPath, outputPath: result.output_path, review: result.review }));
      fs.renameSync(request + '.tmp', request);
      const response = path.join(run, 'overlay-response.json');
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(response) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (!fs.existsSync(response)) throw Error('OCR overlay negative control runner timed out');
      const mutation = JSON.parse(fs.readFileSync(response, 'utf8'));
      if (mutation.runId !== process.env.PDF_E2E_RUN_ID) throw Error('Overlay response identity mismatch');
      Object.assign(record.negativeControl, mutation);
      persist();
      if (!mutation.created) throw Error('OCR overlay negative control failed to create its synthetic result');
    }
  }
  record.outputPath = result.output_path ?? result.zip_path;
  if (result.review) record.review = { version: result.review.version, pageCount: result.review.pageCount, regions: result.review.regions.length };
  persist(); return result;
});
app.on('ready', () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
});
app.on('will-quit', () => {
  const directory = path.join(profile, 'file-sessions');
  const live = observed.backendPids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  fs.writeFileSync(path.join(run, 'shutdown.json'), JSON.stringify({ liveOwnedBackendPids: live,
    remainingSessions: fs.existsSync(directory) ? fs.readdirSync(directory) : [] }, null, 2));
});
persist();
if (!app.isPackaged) nativeRequire(path.join(run, 'build', 'main', 'index.cjs'));
