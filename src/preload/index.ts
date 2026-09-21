import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('fi', {
  retry: () => ipcRenderer.send('fi:retry'),

  // --- 项目模式文件桥（见 src/main/fs-bridge.ts）---
  // 全部返回结构化结果 Promise；只读文件系统 + 系统语义动作。
  fs: {
    home: () => ipcRenderer.invoke('fi:fs:home'),
    readdir: (path: string) => ipcRenderer.invoke('fi:fs:readdir', path),
  },
  shell: {
    open: (path: string) => ipcRenderer.invoke('fi:shell:open', path),
    showInFolder: (path: string) => ipcRenderer.invoke('fi:shell:show-in-folder', path),
  },
  clipboard: {
    write: (text: string) => ipcRenderer.invoke('fi:clipboard:write', text),
  },
})

// --- busy watcher (drives the close confirmation in the main process) ---
// While streaming, dsh's composer swaps its send button for a stop button
// labelled aria-label t("input.stop") → "停止生成" (zh) / "Stop generating"
// (en). If that marker stops matching (dsh update, other UI language), busy
// stays false and closing is simply never blocked — degrade, don't nag.

const BUSY_LABEL_RE = /^(停止生成|stop generating)$/i
const SCAN_INTERVAL_MS = 2000
const IDLE_LAG_MS = 1500

let busy = false
let idleTimer: number | undefined
let scanScheduled = false

function isBusyNow(): boolean {
  const labelled = document.querySelectorAll<HTMLElement>('[aria-label], [title]')
  for (const el of labelled) {
    const label = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').trim()
    if (BUSY_LABEL_RE.test(label)) return true
  }
  return false
}

function report(next: boolean): void {
  if (next) {
    window.clearTimeout(idleTimer)
    idleTimer = undefined
    if (!busy) {
      busy = true
      ipcRenderer.send('fi:busy', true)
    }
    return
  }
  if (!busy || idleTimer !== undefined) return
  // Lag the idle transition so a mid-run flicker of the button doesn't open
  // a close-confirmation window.
  idleTimer = window.setTimeout(() => {
    idleTimer = undefined
    busy = false
    ipcRenderer.send('fi:busy', false)
  }, IDLE_LAG_MS)
}

function scheduleScan(): void {
  if (scanScheduled) return
  scanScheduled = true
  window.setTimeout(() => {
    scanScheduled = false
    report(isBusyNow())
  }, 300)
}

function startWatcher(): void {
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'title', 'class'],
  })
  window.setInterval(() => report(isBusyNow()), SCAN_INTERVAL_MS)
  report(isBusyNow())
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startWatcher, { once: true })
} else {
  startWatcher()
}
