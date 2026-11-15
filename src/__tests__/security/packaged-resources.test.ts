import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pkg from '../../../package.json';
import { createRequire } from 'node:module';

const localRequire = createRequire(path.join(process.cwd(), 'package.json'));
const build = localRequire('./scripts/backend-contract.cjs') as {
  contract(root: string): Record<string, unknown>;
  applicationSource(root: string): { sha256: string };
  preparePackageBackend(root: string, platform: string, arch: string): void;
  verifyPackage(root: string, output: string, platform: string, arch: string, flavor: string, currentDist: boolean): Promise<unknown>;
};
const notices = localRequire('./scripts/package-notices.cjs') as {
  stagePackageNotices(root: string, staging: string, platform: string): void;
  verifyPackageNotices(root: string, resources: string, platform: string): void;
};
const asar = localRequire('@electron/asar') as {
  createPackage(source: string, destination: string): Promise<void>;
};
const owned: string[] = [];
afterEach(() => { for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-resources-'));
  owned.push(root);
  const dist = path.join(root, 'python-backend', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const packageJson = { name: pkg.name, productName: pkg.productName, branding: pkg.branding,
    installIdentity: pkg.installIdentity, license: pkg.license, version: '1.0.0' };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(root, 'python-backend', 'main.py'), 'synthetic backend source');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'release-upstream.json'), '{"mupdfVersion":"1.28.0"}');
  const binary = Buffer.from('synthetic backend executable');
  const pythonLicenses = Buffer.from('synthetic Python license archive');
  fs.writeFileSync(path.join(dist, 'python_backend.exe'), binary);
  fs.writeFileSync(path.join(dist, 'python-licenses.zip'), pythonLicenses);
  const manifest = { contract: build.contract(root), platform: 'win32', arch: 'x64',
    executable: 'python_backend.exe', executableSha256: crypto.createHash('sha256').update(binary).digest('hex'),
    pythonLicensesSha256: crypto.createHash('sha256').update(pythonLicenses).digest('hex'),
    ocrSha256: { [path.join(root, 'private-build-input', 'tesseract.exe')]: 'synthetic hash' },
    internalNote: 'SYNTHETIC_PRIVATE_BUILD_NOTE' };
  const raw = JSON.stringify(manifest);
  fs.writeFileSync(path.join(dist, 'backend-manifest.json'), raw);
  return { root, dist, manifest, raw, binary, pythonLicenses, packageJson };
}

describe('shipped dependency notices', () => {
  it.each(['darwin', 'win32'])('copies the actual runtime notices before packaging on %s', platform => {
    const { root } = fixture();
    const staging = path.join(root, 'extracted-runtime');
    const resources = platform === 'darwin' ? path.join(staging, 'Electron.app', 'Contents', 'Resources')
      : path.join(staging, 'resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(root, 'LICENSE'), 'synthetic project license');
    const files = [
      ['electron', 'LICENSE'], ['electron', 'LICENSES.chromium.html'], ['pdfjs-dist', 'LICENSE'],
      ['@fontsource/dm-sans', 'LICENSE'], ['@fontsource/ibm-plex-sans', 'LICENSE'],
      ['react', 'LICENSE'], ['react-dom', 'LICENSE'], ['electron-squirrel-startup', 'LICENSE'],
      ['scheduler', 'LICENSE'], ['css-loader', 'LICENSE'], ['style-loader', 'LICENSE'],
      ['debug', 'LICENSE', 'electron-squirrel-startup/node_modules/debug'],
      ['ms', 'license.md', 'electron-squirrel-startup/node_modules/ms'],
    ];
    for (const [component, file, modulePath = component] of files) {
      const source = component === 'electron' ? path.join(staging, file)
        : path.join(root, 'node_modules', modulePath, file);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, modulePath + '/' + file);
    }

    const installerNotices = path.join(root, 'scripts/windows-installer/notices');
    fs.mkdirSync(installerNotices, { recursive: true });
    fs.writeFileSync(path.join(installerNotices, 'Squirrel.Windows-COPYING.txt'), 'synthetic installer notice');
    notices.stagePackageNotices(root, staging, platform);
    for (const [component, file, modulePath = component] of files) {
      const published = path.join(resources, 'third-party-licenses', component, file);
      expect(fs.readFileSync(published, 'utf8')).toBe(modulePath + '/' + file);
    }
    const publishedNotice = path.join(resources, 'third-party-licenses/windows-installer/Squirrel.Windows-COPYING.txt');
    if (platform === 'win32') {
      expect(fs.readFileSync(publishedNotice, 'utf8')).toBe('synthetic installer notice');
      fs.writeFileSync(publishedNotice, 'changed installer notice');
      expect(() => notices.verifyPackageNotices(root, resources, platform)).toThrow(/Changed Windows installer notice/);
      fs.copyFileSync(path.join(installerNotices, 'Squirrel.Windows-COPYING.txt'), publishedNotice);
    } else {
      expect(fs.existsSync(publishedNotice)).toBe(false);
    }
    const license = path.join(resources, 'LICENSE');
    expect(fs.readFileSync(license, 'utf8')).toBe('synthetic project license');
    fs.writeFileSync(license, 'different license');
    expect(() => notices.verifyPackageNotices(root, resources, platform)).toThrow(/packaged project license/);
    fs.copyFileSync(path.join(root, 'LICENSE'), license);
    fs.unlinkSync(path.join(resources, 'third-party-licenses/electron/LICENSES.chromium.html'));
    expect(() => notices.verifyPackageNotices(root, resources, platform)).toThrow(/Missing or empty packaged license/);
    fs.copyFileSync(path.join(staging, 'LICENSES.chromium.html'), path.join(resources, 'third-party-licenses/electron/LICENSES.chromium.html'));
    fs.writeFileSync(path.join(resources, 'third-party-licenses/debug/LICENSE'), 'root debug license instead');
    expect(() => notices.verifyPackageNotices(root, resources, platform)).toThrow(/Changed packaged license: debug/);
  });
});

describe('shipped backend resource boundary', () => {
  it('ships the verified executable without private build paths or extra metadata', () => {
    const f = fixture();
    build.preparePackageBackend(f.root, 'win32', 'x64');
    const staged = path.join(f.root, '.project-state', 'app-build-input', 'dist');
    const raw = fs.readFileSync(path.join(staged, 'backend-manifest.json'), 'utf8');
    expect(raw).not.toContain(f.root);
    expect(raw).not.toContain('SYNTHETIC_PRIVATE_BUILD_NOTE');
    expect(raw).not.toContain('ocrSha256');
    expect(fs.readFileSync(path.join(staged, 'python_backend.exe'))).toEqual(f.binary);
    expect(fs.readFileSync(path.join(staged, 'python-licenses.zip'))).toEqual(f.pythonLicenses);
    expect(fs.readFileSync(path.join(f.dist, 'backend-manifest.json'), 'utf8')).toBe(f.raw);
  });

  it('refuses a changed executable before publishing resources', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dist, 'python_backend.exe'), 'changed executable');
    expect(() => build.preparePackageBackend(f.root, 'win32', 'x64')).toThrow(/does not match/);
    expect(fs.existsSync(path.join(f.root, '.project-state', 'app-build-input', 'dist'))).toBe(false);
  });

  it('refuses the previous backend after the corresponding engine source changes', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, 'scripts', 'release-upstream.json'), '{"mupdfVersion":"1.28.2"}');
    expect(() => build.preparePackageBackend(f.root, 'win32', 'x64')).toThrow(/stale/);
  });

  it('ignores hidden archive metadata next to backend sources', () => {
    const f = fixture();
    const before = build.applicationSource(f.root).sha256;
    fs.writeFileSync(path.join(f.root, 'python-backend', '._main.py'), 'archive metadata');
    expect(build.applicationSource(f.root).sha256).toBe(before);
    expect(build.contract(f.root)).toEqual(f.manifest.contract);
  });

  it('refuses changed Python notices before publishing resources', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dist, 'python-licenses.zip'), 'changed notices');
    expect(() => build.preparePackageBackend(f.root, 'win32', 'x64')).toThrow(/Python licenses do not match/);
    expect(fs.existsSync(path.join(f.root, '.project-state', 'app-build-input', 'dist'))).toBe(false);
  });

  it.each([
    ['runtime name', { productName: 'Redactera' }],
    ['brand metadata', { branding: undefined }],
    ['installer ID', { installIdentity: { ...pkg.installIdentity, squirrelName: 'redactera' } }],
    ['project license', { license: 'MIT' }],
  ])('rejects a real ASAR with mismatched %s', async (_label, overrides) => {
    const f = fixture();
    const input = path.join(f.root, 'asar-input');
    const output = path.join(f.root, 'package');
    const resources = path.join(output, 'resources');
    fs.mkdirSync(input);
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(input, 'package.json'), JSON.stringify({ ...f.packageJson, ...overrides }));
    await asar.createPackage(input, path.join(resources, 'app.asar'));
    await expect(build.verifyPackage(f.root, output, 'win32', 'x64', 'normal', false))
      .rejects.toThrow(/name or installation identity|project license metadata/);
  });

  it('rejects a paired old frontend at the same version after only application source changes', async () => {
    const f = fixture();
    const source = path.join(f.root, 'src');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'renderer.tsx'), 'synthetic older frontend');
    const input = path.join(f.root, 'asar-input');
    const output = path.join(f.root, 'package');
    const resources = path.join(output, 'resources');
    fs.mkdirSync(input); fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(input, 'package.json'), JSON.stringify(f.packageJson));
    await asar.createPackage(input, path.join(resources, 'app.asar'));
    const before = build.applicationSource(f.root).sha256;
    fs.writeFileSync(path.join(resources, 'app-build.json'), JSON.stringify({ schema: 2, applicationSourceSha256: before }));
    fs.writeFileSync(path.join(source, 'renderer.tsx'), 'synthetic fixed frontend');
    expect(build.applicationSource(f.root).sha256).not.toBe(before);
    expect(build.contract(f.root)).toEqual(f.manifest.contract);
    await expect(build.verifyPackage(f.root, output, 'win32', 'x64', 'normal', false))
      .rejects.toThrow('application source does not match');
  });

  it('rejects private metadata in a real ASAR package even when using bundled identity', async () => {
    const f = fixture();
    const input = path.join(f.root, 'asar-input');
    const output = path.join(f.root, 'package');
    const resources = path.join(output, 'resources');
    fs.mkdirSync(input); fs.mkdirSync(path.join(resources, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(input, 'package.json'), JSON.stringify(f.packageJson));
    await asar.createPackage(input, path.join(resources, 'app.asar'));
    fs.writeFileSync(path.join(resources, 'app-build.json'), JSON.stringify({ schema: 2,
      applicationSourceSha256: build.applicationSource(f.root).sha256 }));
    fs.writeFileSync(path.join(resources, 'dist', 'backend-manifest.json'), f.raw);
    await expect(build.verifyPackage(f.root, output, 'win32', 'x64', 'normal', false))
      .rejects.toThrow(/build-only information/);
  });
});
