import { clipboard, ipcMain, shell } from 'electron'
import type { Dirent } from 'node:fs'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * fi 文件桥：项目模式文件浏览器的只读本地文件系统通道。渲染进程经 preload
 * 暴露的 window.fi.* 调用这里。页面本身就能运行 shell 会话，故不设路径
 * 白名单，与 dsh 对文件读取的取舍一致；桥面刻意保持最小：列目录、取主目录、
 * 系统打开/Finder 显示、写剪贴板——全部只读或系统语义，不提供任何写入。
 */

/** 单层目录列举的条目上限，对齐 dsh 目录浏览原语的默认 maxEntries。 */
const MAX_ENTRIES = 1000
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export interface FsEntry {
  name: string
  /** 绝对路径；调用方直接使用，不在渲染层拼路径。 */
  path: string
  type: 'directory' | 'file' | 'other'
  isSymlink: boolean
}

export type FsListResult =
  | { ok: true; entries: FsEntry[]; truncated: boolean }
  | { ok: false; code: string; message: string }

export interface SimpleResult {
  ok: boolean
  code?: string
  message?: string
}

function failure(err: unknown): { ok: false; code: string; message: string } {
  const e = err as { code?: string; message?: string }
  return { ok: false, code: e?.code ?? 'unknown', message: e?.message ?? String(err) }
}

function absolute(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && isAbsolute(value)
}

/** 符号链接按目标归类；断链保持 other（客户端灰显不可点），循环链接不会在单层列举里成环。 */
async function toEntry(dir: string, dirent: Dirent): Promise<FsEntry> {
  const isSymlink = dirent.isSymbolicLink()
  const entry: FsEntry = { name: dirent.name, path: join(dir, dirent.name), type: 'other', isSymlink }
  let kind: FsEntry['type'] = dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other'
  if (isSymlink) {
    try {
      const target = await fs.stat(entry.path)
      kind = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other'
    } catch {
      kind = 'other'
    }
  }
  entry.type = kind
  return entry
}

export function registerFsBridge(): void {
  ipcMain.handle('fi:fs:home', (): SimpleResult & { path?: string } => ({ ok: true, path: homedir() }))

  ipcMain.handle('fi:fs:readdir', async (_event, dir: unknown): Promise<FsListResult> => {
    if (!absolute(dir)) return { ok: false, code: 'bad-path', message: 'absolute directory path required' }
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true })
      const entries = await Promise.all(dirents.map((d) => toEntry(dir, d)))
      entries.sort((a, b) => {
        if (a.type !== b.type) {
          if (a.type === 'directory') return -1
          if (b.type === 'directory') return 1
        }
        return collator.compare(a.name, b.name)
      })
      return {
        ok: true,
        entries: entries.slice(0, MAX_ENTRIES),
        truncated: entries.length > MAX_ENTRIES,
      }
    } catch (err) {
      return failure(err)
    }
  })

  ipcMain.handle('fi:shell:open', async (_event, path: unknown): Promise<SimpleResult> => {
    if (!absolute(path)) return { ok: false, code: 'bad-path' }
    const message = await shell.openPath(path)
    return message === '' ? { ok: true } : { ok: false, code: 'open-failed', message }
  })

  ipcMain.handle('fi:shell:show-in-folder', (_event, path: unknown): SimpleResult => {
    if (!absolute(path)) return { ok: false, code: 'bad-path' }
    shell.showItemInFolder(path)
    return { ok: true }
  })

  ipcMain.handle('fi:clipboard:write', (_event, text: unknown): SimpleResult => {
    if (typeof text !== 'string') return { ok: false, code: 'bad-request' }
    clipboard.writeText(text)
    return { ok: true }
  })
}
