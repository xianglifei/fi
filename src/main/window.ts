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

/**
 * Strict origin equality, not a string prefix match: "http://127.0.0.1:123"
 * must not treat "http://127.0.0.1:1234.evil.com" as same-origin. Unparsable
 * URLs count as external (they get blocked, never opened externally).
 */
function isInternalUrl(url: string): boolean {
  if (dshOrigin === null) return false
  try {
    return new URL(url).origin === dshOrigin
  } catch {
    return false
  }
}

// dsh's web UI brands its pages via document.title ("DeepSeek Harness" /
// "<task> - DeepSeek Harness"), which Electron mirrors into the native
// window title. Rewritten here so the shell brands itself as fi instead
// ("fi" / "<task> - fi"); titles without the brand pass through untouched.
const DSH_BRAND = 'DeepSeek Harness'

function retitleToFi(win: BrowserWindow): void {
  win.on('page-title-updated', (event, title) => {
    if (!title.includes(DSH_BRAND)) return
    event.preventDefault() // or Electron overwrites setTitle with the page title
    const rewritten = title.split(DSH_BRAND).join('fi')
    if (process.env.FI_TITLE_TRACE !== undefined) console.log(`[fi] title: ${JSON.stringify(rewritten)}`)
    win.setTitle(rewritten)
  })
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
  retitleToFi(win)

  // window.open: same-origin (attachment previews etc.) opens a small popup
  // sharing the auth session; anything external goes to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) {
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
      retitleToFi(popup)
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
    if (isInternalUrl(url)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
}
