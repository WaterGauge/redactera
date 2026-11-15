import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Shell, ShortcutDetails } from 'electron';
import pkg from '../../package.json';
import { diagnosticErrorKind } from './diagnostics';

const legacyExecutable = pkg.productName + '.exe';
const brandedExecutable = pkg.branding.name + '.exe';
const legacyShortcut = pkg.productName + '.lnk';
const brandedShortcut = pkg.branding.nameZh + '.lnk';
const englishShortcut = pkg.branding.name + '.lnk';

export const windowsAppUserModelId = `com.squirrel.${pkg.installIdentity.squirrelName}.${pkg.branding.name}`;

type ShortcutShell = Pick<Shell, 'readShortcutLink'> & {
  writeShortcutLink(file: string, operation: 'update', details: ShortcutDetails): boolean;
};

function samePath(left: string, right: string): boolean {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}

function isVersionDirectory(name: string): boolean {
  return /^app-\d+\.\d+\.\d+(?:-[a-z\d.-]+)?$/i.test(name);
}

export function updateWindowsInstallIcon(executable: string, sourceIcon: string,
  run: (file: string, args: string[]) => string = (file, args) =>
    execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'] })): void {
  const versionDirectory = path.dirname(executable);
  const installRoot = path.dirname(versionDirectory);
  if (!path.isAbsolute(executable) || !samePath(path.basename(executable), brandedExecutable) ||
      !isVersionDirectory(path.basename(versionDirectory)) ||
      !samePath(path.basename(installRoot), pkg.installIdentity.squirrelName) ||
      !fs.lstatSync(path.join(installRoot, 'Update.exe'), { throwIfNoEntry: false })?.isFile()) return;
  const icon = path.join(installRoot, 'app.ico');
  const existing = fs.lstatSync(icon, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) return;
  const bytes = fs.readFileSync(sourceIcon);
  if (!existing || !fs.readFileSync(icon).equals(bytes)) {
    const temporary = path.join(installRoot, '.app-icon-' + randomUUID() + '.ico');
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx' });
      fs.renameSync(temporary, icon);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + pkg.installIdentity.squirrelName;
  let record: string;
  try { record = run('reg.exe', ['query', key, '/v', 'InstallLocation']); }
  catch { return; } // Squirrel may create the entry after its install callback.
  const location = record.match(/InstallLocation\s+REG_SZ\s+([^\r\n]+)/)?.[1].trim();
  if (location && samePath(location, installRoot)) {
    run('reg.exe', ['add', key, '/v', 'DisplayIcon', '/t', 'REG_SZ', '/d', icon, '/f']);
  }
}

export function updateWindowsShortcuts(executable: string, desktop: string, appData: string, shell: ShortcutShell,
  preferredLanguage: string | undefined, operation: 'install' | 'uninstall' = 'install'): void {
  const versionDirectory = path.dirname(executable);
  const installRoot = path.dirname(versionDirectory);
  const target = path.join(installRoot, brandedExecutable);
  const regularFile = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() === true;

  try {
    if (!path.isAbsolute(executable) || !samePath(path.basename(executable), brandedExecutable) ||
        !isVersionDirectory(path.basename(versionDirectory)) ||
        !samePath(path.basename(installRoot), pkg.installIdentity.squirrelName) || !regularFile(target)) return;
  } catch (error) {
    console.warn('Unable to inspect Windows shortcut migration:', diagnosticErrorKind(error));
    return;
  }

  const ownsExecutable = (file: string, name: string) => {
    const parent = path.dirname(path.normalize(file));
    return path.isAbsolute(file) && samePath(path.basename(file), name) &&
      (samePath(parent, installRoot) ||
        (samePath(path.dirname(parent), installRoot) && isVersionDirectory(path.basename(parent))));
  };

  if (operation === 'uninstall') {
    const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    for (const folder of [desktop, programs, path.join(programs, pkg.author)]) {
      for (const name of [legacyShortcut, brandedShortcut, englishShortcut]) {
        const file = path.join(folder, name);
        try {
          if (!regularFile(file)) continue;
          const target = shell.readShortcutLink(file).target;
          if (ownsExecutable(target, brandedExecutable) || ownsExecutable(target, legacyExecutable)) fs.unlinkSync(file);
        } catch (error) {
          console.warn('Unable to remove a Windows shortcut:', diagnosticErrorKind(error));
        }
      }
    }
    return;
  }

  const launchArguments = (link: ShortcutDetails): string | undefined => {
    const args = link.args ?? '';
    if (ownsExecutable(link.target, legacyExecutable) || ownsExecutable(link.target, brandedExecutable)) return args;
    if (samePath(link.target, path.join(installRoot, 'Update.exe'))) {
      const oldName = args.match(/^--processStart(?:=|\s+)(.+)$/i)?.[1].trim().replace(/^"(.*)"$/, '$1');
      if (oldName?.toLowerCase() === legacyExecutable.toLowerCase()) return '';
    }
    return undefined;
  };

  const migrate = (file: string, renamed?: string, description = pkg.branding.nameZh) => {
    try {
      if (!regularFile(file)) return;
      const link = shell.readShortcutLink(file);
      const args = launchArguments(link);
      if (args === undefined) return;
      if (!renamed && samePath(link.target, target) && link.appUserModelId === windowsAppUserModelId) return;

      if (!shell.writeShortcutLink(file, 'update', {
        target, args, cwd: versionDirectory, icon: target, iconIndex: 0,
        description, appUserModelId: windowsAppUserModelId,
      })) return;

      if (renamed) {
        const existing = fs.lstatSync(renamed, { throwIfNoEntry: false });
        if (existing) {
          if (!existing.isFile()) return;
          const replacement = shell.readShortcutLink(renamed);
          if (!ownsExecutable(replacement.target, brandedExecutable) || (replacement.args ?? '') !== args) return;
        } else {
          fs.copyFileSync(file, renamed, fs.constants.COPYFILE_EXCL);
        }
        fs.unlinkSync(file);
      }
    } catch (error) {
      console.warn('Unable to migrate a Windows shortcut:', diagnosticErrorKind(error));
    }
  };

  const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const chineseDesktop = /^zh(?:[-_]|$)/i.test(preferredLanguage ?? '');
  const desktopName = chineseDesktop ? brandedShortcut : englishShortcut;
  const otherName = chineseDesktop ? englishShortcut : brandedShortcut;
  const description = chineseDesktop ? pkg.branding.nameZh : pkg.branding.name;
  const desktopLink = path.join(desktop, desktopName);
  migrate(path.join(desktop, legacyShortcut), desktopLink, description);
  migrate(path.join(desktop, otherName), desktopLink, description);

  for (const folder of [programs, path.join(programs, pkg.author)]) {
    migrate(path.join(folder, legacyShortcut), path.join(folder, brandedShortcut));
  }

  // Windows owns the pin registration. Update the target and identity in place.
  const taskbar = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
  try {
    for (const file of fs.readdirSync(taskbar, { withFileTypes: true })) {
      if (file.isFile() && path.extname(file.name).toLowerCase() === '.lnk') migrate(path.join(taskbar, file.name));
    }
  } catch (error) {
    const code = diagnosticErrorKind(error);
    if (code !== 'ENOENT') console.warn('Unable to inspect Windows taskbar shortcuts:', code);
  }
}
