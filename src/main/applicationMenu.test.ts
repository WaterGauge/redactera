import { describe, expect, it } from 'vitest';
import { macApplicationMenu } from './applicationMenu';

describe('macOS application menu', () => {
  it.each<[string[], boolean]>([
    [['zh-Hans-CN', 'en-US'], true],
    [['zh-CN'], true],
    [['zh-Hant-CN', 'zh-Hans'], false],
    [['zh-TW'], false],
    [['en-US', 'zh-Hans'], false],
    [['ja-JP'], false],
    [[], false],
    [['invalid_language'], false],
  ])('uses the first preferred system language %j', (languages, chinese) => {
    const menu = macApplicationMenu(languages);
    expect(menu.map(item => item.label)).toEqual(chinese
      ? ['页隐', '文件', '编辑', '显示', '窗口']
      : ['页隐', 'File', 'Edit', 'View', 'Window']);
    expect(menu[0].submenu).toContainEqual({ role: 'quit', label: chinese ? '退出页隐' : 'Quit 页隐' });
    expect(menu[2].submenu).toContainEqual({ role: 'copy', label: chinese ? '复制' : 'Copy' });
  });
});
