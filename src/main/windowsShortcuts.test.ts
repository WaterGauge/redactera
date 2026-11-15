import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ShortcutDetails } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json';
import { updateWindowsInstallIcon, updateWindowsShortcuts, windowsAppUserModelId } from './windowsShortcuts';

const oldName = 'PDF Desensitization.lnk';
const newName = '页隐.lnk';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redactera-shortcuts-'));
  roots.push(root);
  const install = path.join(root, 'pdf_desensitization_new');
  const version = path.join(install, 'app-2.0.0-rc1');
  const target = path.join(install, 'Redactera.exe');
  const legacy = path.join(install, 'PDF Desensitization.exe');
  const executable = path.join(version, 'Redactera.exe');
  const desktop = path.join(root, 'Desktop');
  const appData = path.join(root, 'Roaming');
  const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', pkg.author);
  const taskbar = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
  for (const folder of [version, desktop, programs, taskbar]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(target, '');
  fs.writeFileSync(executable, '');
  const read = (file: string): ShortcutDetails => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = (file: string, link: ShortcutDetails) => fs.writeFileSync(file, JSON.stringify(link));
  const link = (folder: string, name: string, details: ShortcutDetails) => {
    const file = path.join(folder, name);
    write(file, details);
    return file;
  };
  const shell = {
    readShortcutLink: read,
    writeShortcutLink: vi.fn((file: string, _operation: 'update', details: ShortcutDetails) => {
      write(file, { ...read(file), ...details });
      return true;
    }),
  };
  return { install, version, target, legacy, executable, desktop, appData, programs, taskbar, link, read, shell };
}

describe('Windows upgrade shortcut branding', () => {
  it('renames app shortcuts, updates the targets of existing pins and can run again', () => {
    const f = fixture();
    const desktopLink = f.link(f.desktop, oldName, { target: f.legacy, args: '' });
    const startLink = f.link(f.programs, oldName, {
      target: path.join(f.install, 'app-1.2.0', 'PDF Desensitization.exe'),
    });
    const pin = f.link(f.taskbar, 'Pinned PDF tool.lnk', {
      target: path.join(f.install, 'Update.exe'), args: '--processStart "PDF Desensitization.exe"',
    });
    const customPin = f.link(f.taskbar, 'Custom pin.lnk', { target: f.legacy, args: '--keep-this' });
    const unrelated = f.link(f.taskbar, 'Unrelated.lnk', {
      target: path.join(f.install + '-other', 'PDF Desensitization.exe'),
    });

    updateWindowsShortcuts(f.executable, f.desktop, f.appData, f.shell, 'zh-CN');

    expect(fs.existsSync(desktopLink)).toBe(false);
    expect(fs.existsSync(startLink)).toBe(false);
    for (const file of [path.join(f.desktop, newName), path.join(f.programs, newName), pin, customPin]) {
      expect(f.read(file)).toMatchObject({
        target: f.target, cwd: f.version, icon: f.target, description: '页隐', appUserModelId: windowsAppUserModelId,
      });
    }
    expect(f.read(pin).args).toBe('');
    expect(f.read(customPin).args).toBe('--keep-this');
    expect(f.read(unrelated).target).toBe(path.join(f.install + '-other', 'PDF Desensitization.exe'));
    expect(f.shell.writeShortcutLink).toHaveBeenCalledTimes(4);
    updateWindowsShortcuts(f.executable, f.desktop, f.appData, f.shell, 'zh-CN');
    expect(f.shell.writeShortcutLink).toHaveBeenCalledTimes(4);
  });

  it.each([['zh-Hant-TW', '页隐.lnk'], ['en-US', 'Redactera.lnk'], ['ja-JP', 'Redactera.lnk']])(
    'uses the desktop display language %s for the stock link', (language, expected) => {
      const f = fixture();
      f.link(f.desktop, newName, { target: f.target });
      f.link(f.programs, newName, { target: f.target });
      updateWindowsShortcuts(f.executable, f.desktop, f.appData, f.shell, language);
      expect(fs.readdirSync(f.desktop)).toEqual([expected]);
      expect(f.read(path.join(f.desktop, expected)).target).toBe(f.target);
      expect(fs.readdirSync(f.programs)).toEqual([newName]);
    });

  it('removes owned Chinese desktop and start menu links on uninstall', () => {
    const f = fixture();
    const desktop = f.link(f.desktop, newName, { target: f.target });
    const start = f.link(f.programs, newName, { target: f.target });
    updateWindowsShortcuts(f.executable, f.desktop, f.appData, f.shell, 'zh-CN', 'uninstall');
    expect(fs.existsSync(desktop)).toBe(false);
    expect(fs.existsSync(start)).toBe(false);
  });

  it('removes the English desktop link on uninstall only when owned', () => {
    const f = fixture();
    const english = 'Redactera.lnk';
    const other = f.link(f.desktop, english, { target: path.join(f.install + '-other', 'Redactera.exe') });
    updateWindowsShortcuts(f.executable, f.desktop, f.appData, f.shell, undefined, 'uninstall');
    expect(fs.existsSync(other)).toBe(true);
    f.link(f.desktop, english, { target: f.target });
    updateWindowsShortcuts(f.executable, f.desktop, f.appData, f.shell, undefined, 'uninstall');
    expect(fs.existsSync(other)).toBe(false);
  });

  it('preserves unrelated shortcuts and leaves a working shortcut when its new name is occupied', () => {
    const f = fixture();
    const unrelated = path.join(f.install, 'other.exe');
    const old = f.link(f.desktop, oldName, { target: unrelated });
    const start = f.link(f.programs, oldName, { target: f.legacy, args: '--open' });
    const existing = f.link(f.programs, newName, { target: unrelated });
    updateWindowsShortcuts(f.executable, f.desktop, f.appData, f.shell, 'zh-CN');
    expect(f.read(old).target).toBe(unrelated);
    expect(f.read(existing).target).toBe(unrelated);
    expect(f.read(start)).toMatchObject({ target: f.target, args: '--open' });
    expect(f.shell.writeShortcutLink).toHaveBeenCalledTimes(1);
  });

  it('preserves the original link if updating it fails or the new launcher is missing', () => {
    const f = fixture();
    const original = f.link(f.desktop, oldName, { target: f.legacy });
    f.shell.writeShortcutLink.mockReturnValueOnce(false);
    updateWindowsShortcuts(f.executable, f.desktop, f.appData, f.shell, 'zh-CN');
    expect(f.read(original).target).toBe(f.legacy);
    expect(fs.existsSync(path.join(f.desktop, newName))).toBe(false);
    fs.unlinkSync(f.target);
    updateWindowsShortcuts(f.executable, f.desktop, f.appData, f.shell, 'zh-CN');
    expect(f.shell.writeShortcutLink).toHaveBeenCalledTimes(1);
    expect(f.read(original).target).toBe(f.legacy);
  });
});

describe('Windows installed icon', () => {
  it('replaces a cached default icon and points the owned uninstall entry at local bytes', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.install, 'Update.exe'), '');
    const source = path.join(f.version, 'project.ico');
    fs.writeFileSync(source, 'synthetic project icon');
    fs.writeFileSync(path.join(f.install, 'app.ico'), 'synthetic older icon');
    const command = vi.fn(() => 'InstallLocation    REG_SZ    ' + f.install);
    updateWindowsInstallIcon(f.executable, source, command);
    expect(fs.readFileSync(path.join(f.install, 'app.ico'), 'utf8')).toBe('synthetic project icon');
    expect(command.mock.calls[1]).toEqual(['reg.exe', [
      'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + pkg.installIdentity.squirrelName,
      '/v', 'DisplayIcon', '/t', 'REG_SZ', '/d', path.join(f.install, 'app.ico'), '/f',
    ]]);
    updateWindowsInstallIcon(f.executable, source, command);
    expect(fs.readdirSync(f.install).filter(name => name.startsWith('.app-icon-'))).toEqual([]);
  });

  it('seeds the icon during an install callback before Squirrel creates its registry entry', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.install, 'Update.exe'), '');
    const source = path.join(f.version, 'project.ico');
    fs.writeFileSync(source, 'synthetic project icon');
    const command = vi.fn(() => { throw new Error('synthetic absent registry key'); });
    updateWindowsInstallIcon(f.executable, source, command);
    expect(fs.readFileSync(path.join(f.install, 'app.ico'), 'utf8')).toBe('synthetic project icon');
    expect(command).toHaveBeenCalledOnce();
  });

  it('preserves an unrelated uninstall entry', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.install, 'Update.exe'), '');
    const source = path.join(f.version, 'project.ico');
    fs.writeFileSync(source, 'synthetic project icon');
    const command = vi.fn(() => 'InstallLocation    REG_SZ    ' + f.install + '-other');
    updateWindowsInstallIcon(f.executable, source, command);
    expect(command).toHaveBeenCalledOnce();
  });
});
