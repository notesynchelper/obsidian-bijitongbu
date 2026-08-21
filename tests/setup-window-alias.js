// 生产代码为 popout window 兼容统一使用 window.setTimeout / window.clearTimeout
// （obsidianmd/prefer-window-timers）。jest 的 node 测试环境没有 window ——
// 给一个指回 globalThis 的别名，让计时器照常工作。
// 个别 spec（forcedLang / DailyNoteResolver 等）会整体覆写 globalThis.window
// 来注入 localStorage/moment stub；setupFiles 每个测试文件都会重跑，互不污染。
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis
}
