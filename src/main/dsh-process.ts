import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { ensurePluginInstalled } from './dsh-plugin'

export type DshState = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'

/**
 * fi boots its own dsh profile so the shell is isolated from the user's
 * browser-side `dsh web` profile (~/.dsh/profiles/web carries whatever
 * plugins they installed there — peak-hours, whale-widget, …). On first run
 * the profile is initialized from the shipped web template (base bundles
 * only); sessions/settings/credentials stay shared at the home level.
 */
const PROFILE_NAME = 'fi'
const PROFILE_TEMPLATE = 'web'

/** The only machine-readable handshake dsh offers: the printed launch line. */
const URL_LINE_RE = /https?:\/\/127\.0\.0\.1:\d+\/\?token=\S+/
const ANSI_RE = /\[[0-9;?]*[A-Za-z]/g

// Generous because the very first boot also initializes the profile.
const URL_TIMEOUT_MS = 30_000
const KILL_GRACE_MS = 3_000
const MAX_BACKOFF_MS = 30_000
const STDOUT_TAIL_BYTES = 32 * 1024

export class DshProcess extends EventEmitter {
  state: DshState = 'idle'
  url: string | null = null
  lastError: string | null = null

  private child: ChildProcess | null = null
  private prepareChildren: ChildProcess[] = []
  private stopping = false
  private disposed = false
  private attempts = 0
  private preparing = false
  private urlTimer: NodeJS.Timeout | null = null
  private killTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private stdoutTail = ''

  static resolveBinary(): string | null {
    const override = process.env.FI_DSH_BIN
    const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean)
    const candidates = [
      ...(override ? [override] : []),
      ...pathDirs.map((dir) => join(dir, 'dsh')),
      '/opt/homebrew/bin/dsh',
      '/usr/local/bin/dsh',
      join(homedir(), '.local', 'bin', 'dsh'),
    ]
    return candidates.find((p) => existsSync(p)) ?? null
  }

  constructor() {
    super()
  }

  start(): void {
    if (this.state !== 'idle') return
    // Escape hatch: attach to an already-running `dsh --profile web` instead
    // of spawning one (FI_DSH_URL=http://127.0.0.1:3080/?token=...).
    const forced = process.env.FI_DSH_URL
    if (forced) {
      this.url = forced
      this.state = 'ready'
      this.emit('url', forced)
      return
    }
    this.spawnDsh()
  }

  retry(): void {
    this.disposed = false
    this.stopping = false
    this.lastError = null
    this.attempts = 0
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (this.url !== null) return // FI_DSH_URL override
    if (this.child) return
    this.spawnDsh()
  }

  /** SIGTERM → grace → SIGKILL. Resolves once the child is gone. */
  dispose(): Promise<void> {
    this.stopping = true
    if (this.urlTimer) clearTimeout(this.urlTimer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.urlTimer = this.restartTimer = null
    // Preparation children (first-run init server, plugin install) must not
    // outlive us either — quit can land mid-preparation.
    for (const extra of this.prepareChildren) {
      try {
        extra.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    this.prepareChildren = []
    const child = this.child
    if (!child) {
      this.state = 'stopped'
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        if (this.killTimer) clearTimeout(this.killTimer)
        this.killTimer = null
        this.child = null
        this.state = 'stopped'
        resolve()
      }
      child.once('exit', finish)
      child.once('error', finish)
      child.kill('SIGTERM')
      this.killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS)
      // Belt-and-braces: never hang app quit on a wedged child.
      setTimeout(finish, KILL_GRACE_MS + 5_000)
    })
  }

  private dshHome(): string {
    return process.env.DSH_HOME ?? join(homedir(), '.dsh')
  }

  private setState(state: DshState): void {
    if (this.state === state) return
    this.state = state
    this.emit('state', state)
  }

  private fail(error: string): void {
    this.lastError = error
    this.setState('failed')
    this.emit('error', new Error(error))
    // A spawn that never prints its URL may still be sitting on a prompt;
    // tear it down so a retry starts clean.
    const child = this.child
    if (child) {
      this.child = null
      child.once('exit', () => {})
      child.kill('SIGTERM')
    }
  }

  /**
   * One-time boot preparation (first-run profile init, sidebar plugin link-in)
   * before the real headless dsh spawn. Preparation failures degrade: a failed
   * plugin install keeps the stock sidebar, only a failed profile init fails.
   */
  private spawnDsh(): void {
    if (this.preparing) return
    this.preparing = true
    const bin = DshProcess.resolveBinary()
    if (!bin) {
      this.preparing = false
      this.fail('找不到 dsh 可执行文件；请安装 @deepseek-ai/dsh 或设置 FI_DSH_BIN 指向它')
      return
    }
    this.setState(this.attempts === 0 ? 'starting' : 'restarting')
    void (async () => {
      const profileDir = join(this.dshHome(), 'profiles', PROFILE_NAME)
      // First launch initializes ~/.dsh/profiles/fi from the shipped web
      // template; afterwards boot the existing profile directly.
      if (!existsSync(join(profileDir, 'package.json'))) {
        await this.initProfile(bin)
      }
      // The fi sidebar rides a bundled dsh plugin; link it in once. A failed
      // install only costs us the redesigned sidebar, never the shell itself.
      await ensurePluginInstalled(bin, this.dshHome(), PROFILE_NAME)
      this.preparing = false
      if (!this.stopping && !this.disposed) this.spawnDshProcess(bin)
    })().catch((err: unknown) => {
      this.preparing = false
      this.fail(`dsh profile 初始化失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /**
   * First-run profile initialization. dsh has no "init only" mode: the same
   * command initializes the profile and then serves it. We let it run until it
   * prints the ready URL (profile usable), then stop that throwaway server and
   * link the sidebar plugin before the real spawn — plugin install needs the
   * profile's package.json to exist, and mutating it under a live dsh would
   * race the boot scan.
   */
  private initProfile(bin: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        bin,
        [
          '--profile',
          PROFILE_NAME,
          '--from-default-profile',
          PROFILE_TEMPLATE,
          '--port',
          '0',
          '--no-open',
        ],
        {
          cwd: homedir(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      this.prepareChildren.push(child)
      let tail = ''
      let urlSeen = false
      let settled = false
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        finish(false, `初始化超时（${URL_TIMEOUT_MS / 1000}s 内未就绪）`)
      }, URL_TIMEOUT_MS)
      const finish = (ok: boolean, why: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (ok) resolve()
        else reject(new Error(why))
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        tail = (tail + chunk.toString('utf8')).slice(-STDOUT_TAIL_BYTES)
        if (urlSeen) return
        if (!URL_LINE_RE.test(tail.replace(ANSI_RE, ''))) return
        urlSeen = true
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        tail = (tail + chunk.toString('utf8')).slice(-STDOUT_TAIL_BYTES)
      })
      child.on('error', (err) => finish(false, err.message))
      child.on('exit', (code) => {
        if (urlSeen) finish(true, '')
        else finish(false, `初始化进程提前退出（code=${code}）：${tail.trim().split('\n').slice(-3).join(' | ')}`)
      })
    })
  }

  private spawnDshProcess(bin: string): void {
    if (this.stopping || this.disposed) return
    this.url = null
    this.stdoutTail = ''

    // dsh's bin is a node script run via shebang, so `node` must be on PATH —
    // true in dev; revisit when packaging (ELECTRON_RUN_AS_NODE trick).
    const child = spawn(
      bin,
      [
        '--profile',
        PROFILE_NAME,
        '--port',
        '0',
        '--no-open',
      ],
      {
        cwd: homedir(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    this.child = child

    this.urlTimer = setTimeout(() => {
      if (this.state === 'starting' || this.state === 'restarting') {
        this.fail(`dsh web 启动后 ${URL_TIMEOUT_MS / 1000}s 内未输出登录 URL`)
      }
    }, URL_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutTail += chunk.toString('utf8')
      if (this.stdoutTail.length > STDOUT_TAIL_BYTES * 2) {
        this.stdoutTail = this.stdoutTail.slice(-STDOUT_TAIL_BYTES)
      }
      if (this.url !== null) return
      const match = URL_LINE_RE.exec(this.stdoutTail.replace(ANSI_RE, ''))
      if (!match) return
      if (this.urlTimer) clearTimeout(this.urlTimer)
      this.urlTimer = null
      this.url = match[0]
      this.attempts = 0
      this.setState('ready')
      this.emit('url', this.url)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[dsh] ${chunk}`)
    })

    child.on('error', (err) => {
      if (this.child === child) this.child = null
      if (this.urlTimer) clearTimeout(this.urlTimer)
      this.urlTimer = null
      if (this.stopping) return
      this.fail(`dsh 进程启动失败：${err.message}`)
    })

    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null
      if (this.urlTimer) clearTimeout(this.urlTimer)
      this.urlTimer = null
      if (this.stopping) {
        this.setState('stopped')
        return
      }
      // Unexpected exit — dsh crashed or was killed externally. Restart with
      // exponential backoff; the window reloads once the new URL arrives.
      this.attempts += 1
      const delay = Math.min(1000 * 2 ** (this.attempts - 1), MAX_BACKOFF_MS)
      this.setState('restarting')
      this.emit('dsh-exited', code, signal)
      this.restartTimer = setTimeout(() => this.spawnDsh(), delay)
    })
  }
}
