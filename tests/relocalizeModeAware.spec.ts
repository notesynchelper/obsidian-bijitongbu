/**
 * 修复 2：非 LOCAL 模式的菜单和最终提示必须明确只处理附件。
 */

import {
  formatRelocalizeNotice,
  getFolderRelocalizeMenuTitle,
  getRelocalizeMenuTitle,
} from '../src/common/relocalizeNotice'

describe('修复 2：右键入口模式感知', () => {
  test('REMOTE/DISABLED 使用附件专用标题和提示，LOCAL 保持原成功文案', () => {
    expect(getRelocalizeMenuTitle(false)).toBe('将本笔记附件重新本地化')
    expect(getFolderRelocalizeMenuTitle(false)).toBe(
      '将本文件夹附件重新本地化',
    )
    expect(
      formatRelocalizeNotice({
        basename: '文章',
        imageModeEnabled: false,
        failed: 0,
      }),
    ).toBe('图片模式未开启，仅处理了附件: 文章')

    expect(getRelocalizeMenuTitle(true)).toBe('将本笔记图片重新本地化')
    expect(getFolderRelocalizeMenuTitle(true)).toBe(
      '将本文件夹图片重新本地化',
    )
    expect(
      formatRelocalizeNotice({
        basename: '文章',
        imageModeEnabled: true,
        failed: 0,
      }),
    ).toBe('本地化完成: 文章')
  })
})
