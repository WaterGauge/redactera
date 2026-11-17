import type { ForgeConfig } from '@electron-forge/shared-types';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { mainConfig, backendSourceSha256 } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';
import pkg from './package.json';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { verifyIcons } = require('./scripts/check-icons.cjs') as { verifyIcons(root: string): unknown };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prepareWindowsInstallerIcons } = require('./scripts/prepare-windows-icons.cjs') as {
  prepareWindowsInstallerIcons(file: string, iconFile: string): Promise<Record<string, unknown>>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { verify: verifyWindowsInstaller, installerEvidencePath } = require('./scripts/verify-windows-release.cjs') as {
  verify(output: string, setup: string, prepared: unknown, launcherTemplate: string): Promise<{ installerSha256: string }>;
  installerEvidencePath(setupSha256: string): string;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { stagePackageNotices } = require('./scripts/package-notices.cjs') as {
  stagePackageNotices(root: string, extractedRuntime: string, platform: string): void;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { applicationSource, verify, preparePackageBackend, verifyPackage, packagedAppName, macBundleNames } = require('./scripts/backend-contract.cjs') as {
  applicationSource(root: string): { sha256: string };
  verify(root: string, platform: string, arch: string): { contract: { sourceSha256: string }; executableSha256: string };
  preparePackageBackend(root: string, platform: string, arch: string): void;
  packagedAppName(metadata: typeof pkg, platform: string, flavor: string): string;
  macBundleNames(branding: typeof pkg.branding, localization: string, flavor: string): string;
  verifyPackage(root: string, output: string, platform: string, arch: string, flavor: string, currentDist?: boolean): Promise<Record<string, unknown>>;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sealWindowsPayload, verifyWindowsPayload } = require('./scripts/application-payload.cjs') as {
  sealWindowsPayload(root: string, output: string, evidence: Record<string, unknown>): { payloadSha256: string };
  verifyWindowsPayload(root: string, output: string, evidence: Record<string, unknown>): { payloadSha256: string };
};

const enableNodeCliInspectArguments =
  process.env.ELECTRON_ENABLE_NODE_CLI_INSPECT_ARGUMENTS === 'true';
const testBuild = process.env.PDF_E2E_BUILD === 'true';
if (testBuild !== enableNodeCliInspectArguments) throw new Error('Inspect requires the explicit E2E build flavor. Use the controlled package entry.');
const flavor = testBuild ? 'e2e' : 'normal';
const appName = packagedAppName(pkg, process.platform, flavor);
const applicationSourceSha256 = applicationSource(__dirname).sha256;
const buildDirectory = path.join(__dirname, '.project-state', 'app-build-input');
const appBuildFile = path.join(buildDirectory, 'app-build.json');
const windowsInstallerBuild = path.join(__dirname, '.project-state/windows-installer', 'make-' + crypto.randomUUID());

const config: ForgeConfig = {
  outDir: testBuild ? path.join(__dirname, '.project-state/e2e/packages') : undefined,
  packagerConfig: {
    asar: true,
    appCategoryType: 'public.app-category.productivity',
    afterExtract: [({ buildPath, platform }) => stagePackageNotices(__dirname, buildPath, platform)],
    // The locked Electron npm package ships the release checksum table. Keep
    // verification enabled while allowing its already verified archive cache.
    download: { checksums: JSON.parse(fs.readFileSync(path.join(__dirname, 'node_modules/electron/checksums.json'), 'utf8')) as Record<string, string> },
    // Local builds have no Developer ID. Sign the final renamed bundle using
    // Packager's normal inside-out lifecycle, after fuses and resource copies.
    // The early fuse signature alone is invalidated by the later plist changes.
    ...(process.platform === 'darwin' ? { osxSign: {
      identity: '-', identityValidation: false,
      preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      // PyInstaller already signs this executable before hashing its manifest.
      // Changing those bytes here would break the frozen backend contract.
      ignore: (file: string) => file.split(path.sep).join('/').includes('/Contents/Resources/dist/'),
      optionsForFile: () => ({ hardenedRuntime: false, entitlements: [] as string[], timestamp: 'none' }),
    } } : {}),
    extendInfo: { CFBundleDevelopmentRegion: 'en' },
    // This hook runs after Packager writes Info.plist and before signing.
    afterCopyExtraResources: [({ buildPath, platform }) => {
      if (platform !== 'darwin') return;
      const contents = path.join(buildPath, `${appName}.app`, 'Contents');
      // CFBundleName supplies the menu title. CFBundleDisplayName supplies the Dock label.
      const resources = path.join(contents, 'Resources');
      const frameworkDirectory = path.join(contents, 'Frameworks');
      const bundles = [contents, ...fs.readdirSync(frameworkDirectory).filter(name => name.endsWith('.app'))
        .map(name => path.join(frameworkDirectory, name, 'Contents'))];
      for (const bundle of bundles) {
        const plist = path.join(bundle, 'Info.plist');
        const xml = fs.readFileSync(plist, 'utf8');
        for (const key of ['NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription',
          'NSBluetoothPeripheralUsageDescription', 'NSCameraUsageDescription', 'NSMicrophoneUsageDescription']) {
          if (xml.includes('<key>' + key + '</key>')) execFileSync('/usr/bin/plutil', ['-remove', key, plist]);
        }
      }
      const localizations = fs.readdirSync(resources, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.endsWith('.lproj')).map(entry => entry.name);
      for (const localization of new Set(['Base.lproj', 'en.lproj', 'zh-Hans.lproj', 'zh-Hant.lproj', ...localizations])) {
        const directory = path.join(resources, localization);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'InfoPlist.strings'),
          macBundleNames(pkg.branding, localization, flavor), { flag: 'wx' });
      }
    }],
    icon: './assets/icon',
    win32metadata: testBuild ? undefined : {
      ProductName: pkg.branding.nameZh,
      FileDescription: pkg.branding.nameZh,
    },
    extraResource: [path.join(buildDirectory, 'dist'), appBuildFile,
      ...(process.platform === 'win32' ? [path.join(__dirname, 'assets', 'icon.ico')] : [])],
    // Electron initializes profile and key storage from the legacy productName.
    // The packager name controls the visible app and installer names.
    name: appName,
    appBundleId: testBuild ? `${pkg.installIdentity.macBundleId}-e2e` : pkg.installIdentity.macBundleId,
  },
  rebuildConfig: {},
  hooks: {
    generateAssets: async (_config, platform, arch) => {
      verifyIcons(__dirname);
      const manifest = verify(__dirname, platform, arch);
      if (applicationSource(__dirname).sha256 !== applicationSourceSha256) throw new Error('Application source changed during packaging.');
      if (manifest.contract.sourceSha256 !== backendSourceSha256) throw new Error('Source changed after build configuration was loaded.');
      preparePackageBackend(__dirname, platform, arch);
      fs.mkdirSync(buildDirectory, { recursive: true });
      fs.writeFileSync(appBuildFile, JSON.stringify({ schema: 2, buildId: crypto.randomUUID(), flavor, applicationSourceSha256,
        contract: manifest.contract, backendSha256: manifest.executableSha256 }, null, 2));
    },
    prePackage: async (_config, platform, arch) => {
      verify(__dirname, platform, arch);
      if (applicationSource(__dirname).sha256 !== applicationSourceSha256) throw new Error('Application source changed during packaging.');
    },
    preMake: async () => {
      if (testBuild) throw new Error('E2E test packages cannot be made into release installers.');
      if (process.platform === 'win32') {
        if (process.arch !== 'x64') throw new Error('Windows installers require the native x64 application payload.');
        const output = path.join(__dirname, 'out', `${appName}-win32-x64`);
        const evidence = await verifyPackage(__dirname, output, 'win32', 'x64', 'normal', false);
        verifyWindowsPayload(__dirname, output, evidence);
        execFileSync(process.env.PDF_BUILD_PYTHON || 'python',
          [path.join(__dirname, 'scripts/windows-installer/build.py'), windowsInstallerBuild],
          { cwd: __dirname, stdio: 'inherit', timeout: 900_000 });
      }
    },
    postMake: async (_config, results) => {
      if (process.platform === 'win32') {
        const expected = `${pkg.branding.name}-${pkg.version} Setup.exe`;
        let prepared = 0;
        for (const result of results) for (const file of result.artifacts) {
          if (path.basename(file) !== expected) continue;
          const output = path.resolve(path.dirname(file), '../../..', `${pkg.branding.name}-${result.platform}-${result.arch}`);
          const updater = JSON.parse(fs.readFileSync(path.join(windowsInstallerBuild, 'build.json'), 'utf8')) as unknown;
          const proof = await prepareWindowsInstallerIcons(file, path.join(__dirname, 'assets/icon.ico'));
          const verification = await verifyWindowsInstaller(output, file, updater, path.join(windowsInstallerBuild, 'vendor/Setup.exe'));
          const receipt = installerEvidencePath(verification.installerSha256);
          fs.mkdirSync(path.dirname(receipt), { recursive: true });
          fs.writeFileSync(receipt, JSON.stringify(verification, null, 2));
          const directory = path.join(__dirname, '.project-state/windows-installer-icons');
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, String(proof.preparedSha256) + '.json'), JSON.stringify(proof, null, 2));
          prepared++;
        }
        if (!prepared) throw new Error('The expected unsigned Windows installer was not produced.');
      }
      return results;
    },
    postPackage: async (_config, result) => {
      for (const output of result.outputPaths) {
        const evidence = await verifyPackage(__dirname, output, result.platform, result.arch, flavor);
        const storedEvidence = { ...evidence };
        if (!testBuild) {
          delete storedEvidence.binary;
          delete storedEvidence.resources;
        }
        fs.writeFileSync(path.join(output, 'build-evidence.json'), JSON.stringify(storedEvidence, null, 2));
        if (!testBuild && result.platform === 'win32' && result.arch === 'x64') {
          sealWindowsPayload(__dirname, output, storedEvidence);
        }
      }
    },
  },
  makers: [
    new MakerSquirrel({ name: pkg.installIdentity.squirrelName, title: pkg.branding.nameZh,
      description: pkg.branding.nameZh, setupIcon: path.join(__dirname, 'assets', 'icon.ico'),
      loadingGif: path.join(__dirname, 'assets', 'installer.gif'),
      vendorDirectory: path.join(windowsInstallerBuild, 'vendor'), noDelta: true, skipUpdateIcon: true,
      iconUrl: 'https://raw.githubusercontent.com/WaterGauge/redactera/main/assets/icon.ico' }),
    new MakerDMG({ format: 'ULFO', icon: path.join(__dirname, 'assets', 'icon.icns') }, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      // Keep in sync with index.html. Only development source maps need eval;
      // the preview handler still authorizes each pdf-safe file separately.
      devContentSecurityPolicy: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' pdf-safe: ws://localhost:* ws://127.0.0.1:*; worker-src 'self' blob:; frame-src pdf-safe:; object-src 'none'; base-uri 'none'; form-action 'none';",
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/index.html',
            js: './src/renderer.tsx',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
            },
          },
        ],
      },
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: enableNodeCliInspectArguments,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
