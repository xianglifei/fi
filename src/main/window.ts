import { BrowserWindow, session, shell } from 'electron'
import path from 'node:path'

// Origin of the running dsh web server; set once its URL is known. Used to
// tell same-origin popups (previews) from external links.
let dshOrigin: string | null = null

export function setDshOrigin(url: string): void {
  try {
    dshOrigin = new URL(url).origin
  } catch {
    dshOrigin = null
  }
}

export function createMainWindow(): BrowserWindow {
  // Dedicated persistent partition: dsh's 30-day auth cookie and the web
  // app's localStorage live here, separate from any browser profile.
  const ses = session.fromPartition('persist:fi')

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'notifications' || permission === 'clipboard-sanitized-write' || permission === 'fullscreen')
  })

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'fi',
    backgroundColor: '#111418',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => win.show())

  const isInternal = (url: string) => dshOrigin !== null && url.startsWith(dshOrigin)

  // window.open: same-origin (attachment previews etc.) opens a small popup
  // sharing the auth session; anything external goes to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) {
      const popup = new BrowserWindow({
        width: 960,
        height: 720,
        autoHideMenuBar: true,
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      hardenForExternalLinks(popup.webContents)
      popup.once('ready-to-show', () => popup.show())
      void popup.loadURL(url)
    } else if (/^https?:/i.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  hardenForExternalLinks(win.webContents)
  return win
}

/** Main-frame navigation away from dsh goes to the system browser instead. */
function hardenForExternalLinks(contents: Electron.WebContents): void {
  contents.on('will-navigate', (event, url) => {
    const internal = dshOrigin !== null && url.startsWith(dshOrigin)
    if (internal) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
}
