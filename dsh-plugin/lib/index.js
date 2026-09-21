// fi-sidebar —— 服务端半层
//
// 确保隐藏的 default 工作区存在（普通模式的实现基础，见 README）。
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const name = 'fi-sidebar'

/** 与 fi 主进程 dsh-process.ts 的 dshHome() 同一约定：DSH_HOME 覆盖默认 ~/.dsh。 */
function defaultWorkspaceDir() {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'workspace-default')
}

export default {
  name,
  inject: ['workspaceRegistry'],
  apply(ctx) {
    const ensure = async () => {
      const dir = defaultWorkspaceDir()
      await mkdir(dir, { recursive: true })
      await ctx.workspaceRegistry.create(dir, 'default')
    }
    ensure().catch((err) => {
      // 失败不阻断 dsh 启动：客户端半层在 default 缺失时会退化为 dsh 原生的
      // 「继承当前工作区」新建行为，侧栏仍可用。
      const message = `[fi-sidebar] ensure default workspace failed: ${err?.message ?? err}`
      try {
        ctx.logger?.error?.(message)
      } catch {
        console.error(message)
      }
    })
  },
}
