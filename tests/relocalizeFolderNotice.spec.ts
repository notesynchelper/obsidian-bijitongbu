import {
  formatFolderRelocalizeNotice,
} from '../src/common/relocalizeNotice'

describe('文件夹重新本地化文案', () => {
  test('LOCAL 模式成功', () => {
    expect(
      formatFolderRelocalizeNotice({
        folderName: '资料',
        noteCount: 3,
        failed: 0,
        imageModeEnabled: true,
      }),
    ).toBe('本地化完成: 资料（3 个笔记）')
  })

  test('非 LOCAL 模式成功时明确只处理附件', () => {
    expect(
      formatFolderRelocalizeNotice({
        folderName: '/',
        noteCount: 2,
        failed: 0,
        imageModeEnabled: false,
      }),
    ).toBe('图片模式未开启，仅处理了附件: /（2 个笔记）')
  })

  test('LOCAL 模式失败按笔记计数且不含“完成”', () => {
    const notice = formatFolderRelocalizeNotice({
      folderName: '资料',
      noteCount: 3,
      failed: 2,
      imageModeEnabled: true,
    })

    expect(notice).toBe(
      '本地化未成功：2 个笔记仍有远程链接，稍后会自动重试',
    )
    expect(notice).not.toContain('完成')
  })

  test('非 LOCAL 模式失败带模式前缀且不含“完成”', () => {
    const notice = formatFolderRelocalizeNotice({
      folderName: '资料',
      noteCount: 3,
      failed: 1,
      imageModeEnabled: false,
    })

    expect(notice).toBe(
      '图片模式未开启；本地化未成功：1 个笔记仍有远程链接，稍后会自动重试',
    )
    expect(notice).not.toContain('完成')
  })
})
