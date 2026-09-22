import { BrowserWindow, dialog, ipcMain } from 'electron'

/**
 * Confirm before closing while the assistant is streaming. The preload script
 * watches the page for dsh's stop button ("停止生成"/"Stop generating") and
 * reports busy state over `fi:busy`; when the markers can't be found (dsh UI
 * changed, or another UI language), busy stays false and close is instant.
 */
export function attachCloseGuard(win: BrowserWindow): void {
  let busy = false
  let allowClose = false
  let confirming = false

  ipcMain.on('fi:busy', (event, value: unknown) => {
    if (event.sender === win.webContents) busy = value === true
  })

  // Runs for both the red-button close and app quit (Cmd+Q): quit cancels
  // when the close is declined, and proceeds once the window actually closes.
  win.on('close', (event) => {
    if (allowClose || !busy || win.isDestroyed()) return
    // Keep preventing close while the confirmation is up, but don't stack a
    // second dialog on repeated close clicks.
    event.preventDefault()
    if (confirming) return
    confirming = true
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        message: '任务正在进行中',
        detail: '助手仍在输出，现在关闭会中断当前任务。',
        buttons: ['继续等待', '关闭'],
        defaultId: 0,
        cancelId: 0,
      })
      .then(({ response }) => {
        confirming = false
        if (response !== 1 || win.isDestroyed()) return
        allowClose = true
        // Proceeds the pending close; during an aborted Cmd+Q the follow-up
        // window-all-closed → app.quit() picks the quit back up.
        win.close()
      })
  })
}
