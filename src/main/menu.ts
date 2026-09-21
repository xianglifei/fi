import { Menu, app, type MenuItemConstructorOptions } from 'electron'

/**
 * Standard role menus — mostly so copy/paste/undo and zoom/reload work in the
 * embedded page, which a bare Electron window doesn't get on macOS.
 */
export function installMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(isMac
      ? []
      : [
          {
            role: 'about' as const,
            label: `关于 ${app.name}`,
          },
        ]),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
