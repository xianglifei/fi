import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * fi 侧栏改版跑在自带的 dsh 插件 fi-sidebar 里（dsh-plugin/ 目录）：服务端半层
 * 预建隐藏的 default 工作区，客户端半层接管侧栏区域。这里负责在启动 dsh 前把
 * 插件 link 进 fi profile（等价于 `dsh plugin --profile fi add link:<目录>`，
 * 对 package.json 的依赖表和 bundles 列表做幂等修改）。安装失败不阻断启动，
 * 只退化为 dsh 原生侧栏。
 */

const PLUGIN_PACKAGE = 'fi-sidebar'
const ADD_TIMEOUT_MS = 60_000

/** 插件源目录随应用携带；打包/开发路径不同或需要调试时用 FI_PLUGIN_DIR 覆盖。 */
export function pluginSourceDir(): string {
  // out/main/index.js 的上两级：dev 即仓库根；打包后指向 asar 根 —— 届时需把
  // dsh-plugin 挪进 asar 外的 resources（asar 内的文件无法被外部 pnpm link）。
  return process.env.FI_PLUGIN_DIR ?? join(__dirname, '../../dsh-plugin')
}

function profilePackageJsonPath(dshHome: string, profile: string): string {
  return join(dshHome, 'profiles', profile, 'package.json')
}

export function pluginInstalled(dshHome: string, profile: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(profilePackageJsonPath(dshHome, profile), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    const inDeps = pkg.dependencies?.[PLUGIN_PACKAGE] != null
    const inBundles = pkg.dsh?.profile?.bundles?.includes(PLUGIN_PACKAGE) === true
    return inDeps && inBundles
  } catch {
    return false
  }
}

export function ensurePluginInstalled(bin: string, dshHome: string, profile: string): Promise<void> {
  if (pluginInstalled(dshHome, profile)) return Promise.resolve()
  const dir = pluginSourceDir()
  if (!existsSync(join(dir, 'package.json'))) {
    console.warn(`[fi] sidebar plugin source missing at ${dir}; keeping stock dsh sidebar`)
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const child = spawn(bin, ['plugin', '--profile', profile, 'add', `link:${dir}`], {
      cwd: dshHome,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, ADD_TIMEOUT_MS)
    const finish = (ok: boolean, why: string) => {
      clearTimeout(timer)
      if (ok) console.log('[fi] sidebar plugin installed into dsh profile')
      else {
        console.warn(`[fi] sidebar plugin install failed (${why}); keeping stock dsh sidebar`)
        if (output.trim()) console.warn(output.trim().split('\n').slice(-8).join('\n'))
      }
      resolve()
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (err) => finish(false, err.message))
    child.on('exit', (code) => finish(code === 0, `exit code ${code}`))
  })
}
