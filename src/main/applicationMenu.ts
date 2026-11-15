import type { MenuItemConstructorOptions } from 'electron';
import pkg from '../../package.json';

function isSimplifiedChinese(language: string | undefined): boolean {
  if (!language) return false;
  try {
    const locale = new Intl.Locale(language).maximize();
    return locale.language === 'zh' && locale.script === 'Hans';
  } catch {
    return false;
  }
}

export function macApplicationMenu(preferredLanguages: readonly string[]): MenuItemConstructorOptions[] {
  const chinese = isSimplifiedChinese(preferredLanguages[0]);
  const name = pkg.branding.nameZh;
  const label = (zh: string, en: string) => chinese ? zh : en;
  const item = (role: MenuItemConstructorOptions['role'], zh: string, en: string): MenuItemConstructorOptions =>
    ({ role, label: label(zh, en) });
  const separator = { type: 'separator' } as const;

  return [
    { role: 'appMenu', label: name, submenu: [
      item('about', `关于${name}`, `About ${name}`), separator,
      item('services', '服务', 'Services'), separator,
      item('hide', `隐藏${name}`, `Hide ${name}`),
      item('hideOthers', '隐藏其他', 'Hide Others'), item('unhide', '全部显示', 'Show All'), separator,
      item('quit', `退出${name}`, `Quit ${name}`),
    ] },
    { role: 'fileMenu', label: label('文件', 'File'), submenu: [
      item('close', '关闭窗口', 'Close Window'),
    ] },
    { role: 'editMenu', label: label('编辑', 'Edit'), submenu: [
      item('undo', '撤销', 'Undo'), item('redo', '重做', 'Redo'), separator,
      item('cut', '剪切', 'Cut'), item('copy', '复制', 'Copy'), item('paste', '粘贴', 'Paste'),
      item('pasteAndMatchStyle', '粘贴并匹配样式', 'Paste and Match Style'),
      item('delete', '删除', 'Delete'), item('selectAll', '全选', 'Select All'), separator,
      { label: label('替换', 'Substitutions'), submenu: [
        item('showSubstitutions', '显示替换', 'Show Substitutions'), separator,
        item('toggleSmartQuotes', '智能引号', 'Smart Quotes'),
        item('toggleSmartDashes', '智能破折号', 'Smart Dashes'),
        item('toggleTextReplacement', '文本替换', 'Text Replacement'),
      ] },
      { label: label('朗读', 'Speech'), submenu: [
        item('startSpeaking', '开始朗读', 'Start Speaking'), item('stopSpeaking', '停止朗读', 'Stop Speaking'),
      ] },
    ] },
    { role: 'viewMenu', label: label('显示', 'View'), submenu: [
      item('reload', '重新载入', 'Reload'), item('forceReload', '强制重新载入', 'Force Reload'),
      item('toggleDevTools', '开发者工具', 'Toggle Developer Tools'), separator,
      item('resetZoom', '实际大小', 'Actual Size'), item('zoomIn', '放大', 'Zoom In'),
      item('zoomOut', '缩小', 'Zoom Out'), separator,
      item('togglefullscreen', '切换全屏', 'Toggle Full Screen'),
    ] },
    { role: 'windowMenu', label: label('窗口', 'Window'), submenu: [
      item('minimize', '最小化', 'Minimize'), item('zoom', '缩放', 'Zoom'), separator,
      item('front', '将所有窗口置于前台', 'Bring All to Front'),
    ] },
  ];
}
