import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { DshProcess } from './dsh-process'

/**
 * fi 插件中心：fi 专属 profile 的插件清单 + 一键安装。
 *
 * 「已安装」的边界就是 ~/.dsh/profiles/fi/package.json 的 dependencies——只有
 * 在 fi 里装的插件（本面板或命令行 `dsh plugin --profile fi add`）会进这张表，
 * 浏览器 web profile / fx-tui 里装的不算。fi-sidebar 是随壳自动 link 的内置
 * 组件而非用户安装，过滤不展示。安装即转发 `dsh plugin --profile fi add`
 * （与启动时的 ensurePluginInstalled 同一条命令面，底层 pnpm 联网装包比本地
 * link 慢，超时放宽）。运行中的 dsh 不会热加载新 bundle，生效时机由面板提示。
 */

const PROFILE_NAME = 'fi'
const BUILTIN_PLUGINS = ['fi-sidebar']
const INSTALL_TIMEOUT_MS = 180_000
/** 卸载是本地操作（pnpm remove），不需要安装那样的联网余量。 */
const UNINSTALL_TIMEOUT_MS = 60_000
const OUTPUT_TAIL_LINES = 4

export interface InstalledPlugin {
  name: string
  version: string
  description: string
  repo: string | null
}

/** 插件包 package.json 里本面板关心的字段（其余忽略）。 */
export interface PackageMeta {
  version?: unknown
  description?: unknown
  repository?: unknown
}

/** 与 dsh-process.ts / cron.ts 同一约定：DSH_HOME 覆盖默认 ~/.dsh。 */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function profileDir(): string {
  return join(dshHome(), 'profiles', PROFILE_NAME)
}

/** `git+https://…/r.git` → `https://…/r`；非 https（ssh 等）不外显，返回 null。 */
export function normalizeRepoUrl(raw: unknown): string | null {
  let url = raw
  if (typeof url === 'object' && url !== null) {
    url = (url as { url?: unknown }).url
  }
  if (typeof url !== 'string' || url === '') return null
  const https = url.startsWith('git+') ? url.slice(4) : url
  if (!https.startsWith('https://')) return null
  return https.replace(/\.git$/, '')
}

/**
 * 依赖表 → 已安装插件行。readPkg 读 node_modules/<name>/package.json（缺失/
 * 损坏返回 null）：版本回退为依赖 spec（link:/github: 前缀如实展示），描述与
 * 仓库地址缺失就留空。内置组件过滤，输出按包名排序。
 */
export function collectInstalled(
  deps: Record<string, string>,
  readPkg: (name: string) => PackageMeta | null,
): InstalledPlugin[] {
  return Object.keys(deps)
    .filter((name) => !BUILTIN_PLUGINS.includes(name))
    .sort()
    .map((name) => {
      const meta = readPkg(name)
      const version = typeof meta?.version === 'string' && meta.version !== '' ? meta.version : deps[name]
      const description = typeof meta?.description === 'string' ? meta.description : ''
      return { name, version, description, repo: normalizeRepoUrl(meta?.repository) }
    })
}

/** profile package.json 缺失/损坏 → 空表（未初始化或异常 profile 都不算装过）。 */
export function listInstalled(): InstalledPlugin[] {
  let deps: Record<string, string>
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    deps = pkg.dependencies ?? {}
  } catch {
    return []
  }
  return collectInstalled(deps, (name) => {
    try {
      return JSON.parse(readFileSync(join(profileDir(), 'node_modules', name, 'package.json'), 'utf8')) as PackageMeta
    } catch {
      return null
    }
  })
}

function notifyWindows(): void {
  const plugins = listInstalled()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('fi:plugins:changed', plugins)
  }
}

/**
 * `dsh plugin --profile fi add|remove <target>`；成功重查清单推全量，失败把
 * pnpm 输出尾行带回给面板。安装/卸载共用同一条 spawn 骨架（已实证 remove 会
 * 同时清理依赖表与 bundles 列表）。
 */
function runDshPlugin(
  subcommand: 'add' | 'remove',
  target: string,
  timeoutMs: number,
  failWord: string,
): Promise<{ ok: boolean; error?: string }> {
  const bin = DshProcess.resolveBinary()
  if (bin === null) {
    return Promise.resolve({ ok: false, error: '找不到 dsh 可执行文件；请安装 @deepseek-ai/dsh 或设置 FI_DSH_BIN' })
  }
  return new Promise((resolve) => {
    const child = spawn(bin, ['plugin', '--profile', PROFILE_NAME, subcommand, target], {
      cwd: dshHome(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    const finish = (ok: boolean, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (ok) {
        notifyWindows()
        resolve({ ok: true })
        return
      }
      const tail = output.trim().split('\n').slice(-OUTPUT_TAIL_LINES).join(' | ')
      resolve({ ok: false, error: error ?? (tail !== '' ? tail : `${failWord}失败`) })
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (err) => finish(false, err.message))
    child.on('exit', (code) =>
      finish(code === 0 && !timedOut, timedOut ? `${failWord}超时（超过 ${timeoutMs / 1000}s）` : undefined),
    )
  })
}

export function installPlugin(spec: string): Promise<{ ok: boolean; error?: string }> {
  return runDshPlugin('add', spec, INSTALL_TIMEOUT_MS, '安装')
}

export function uninstallPlugin(name: string): Promise<{ ok: boolean; error?: string }> {
  return runDshPlugin('remove', name, UNINSTALL_TIMEOUT_MS, '卸载')
}

/** 卸载目标的合法包名；内置组件不允许经此移除（侧栏会整个退回原生）。 */
export function isRemovablePluginName(raw: unknown): raw is string {
  return typeof raw === 'string' && raw !== '' && !BUILTIN_PLUGINS.includes(raw) && /^[\w@][\w./-]*$/.test(raw)
}

export function registerPluginCenterBridge(): void {
  ipcMain.handle('fi:plugins:list', () => ({ ok: true, plugins: listInstalled() }))
  ipcMain.handle('fi:plugins:install', (_event, spec: unknown) => {
    if (typeof spec !== 'string' || spec.trim() === '' || /[\u0000-\u001f]/.test(spec)) {
      return Promise.resolve({ ok: false, error: '无效的插件标识' })
    }
    return installPlugin(spec.trim())
  })
  ipcMain.handle('fi:plugins:remove', (_event, name: unknown) =>
    isRemovablePluginName(name)
      ? uninstallPlugin(name)
      : Promise.resolve({ ok: false, error: '无效的插件名' }))
}
