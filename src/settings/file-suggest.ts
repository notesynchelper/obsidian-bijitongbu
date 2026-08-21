// 市场版：改用 Obsidian 官方 AbstractInputSuggest（1.4.10+），替代旧的
// Popper.js 自制 TextInputSuggest（触碰内部 app.dom/app.keymap，审核不允许）。

import { AbstractInputSuggest, App, TFolder } from 'obsidian'

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    app: App,
    private readonly folderInputEl: HTMLInputElement,
  ) {
    super(app, folderInputEl)
  }

  getSuggestions(inputStr: string): TFolder[] {
    const lowerCaseInputStr = inputStr.toLowerCase()
    const folders: TFolder[] = []
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (f instanceof TFolder && f.path.toLowerCase().contains(lowerCaseInputStr)) {
        folders.push(f)
      }
    }
    return folders
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path)
  }

  selectSuggestion(folder: TFolder): void {
    this.folderInputEl.value = folder.path
    this.folderInputEl.trigger('input')
    this.close()
  }
}
