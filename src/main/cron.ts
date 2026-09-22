import { BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type { DshProcess } from './dsh-process'

/**
 * fi 定时任务：任务存储 + 调度循环 + 派发 + IPC 面。
 *
 * 状态语义对齐 ZCode Automations 的定时任务页（四档筛选与徽章同源）：
 * - completed 是有限计划自然耗尽的终态，不可通过启停复活；
 * - failed 仅表示派发失败，可重新启用（= 重启，重排下一次运行）；
 * - 循环任务某轮派发失败只留 lastError（失败徽章口径），调度照常推进；
 * - runCount 只计定时触发，手动「立即运行」不消耗计划次数。
 *
 * 派发走 dsh web 官方 API 链（已实证）：workspace/create（按 canonical path
 * 幂等）→ session/create({workspaceId})（即时计入工作区会话清单）→
 * session/prompt（accepted 即视为派发成功，运行过程在 UI 可见）。
 * 关机/退出期间错过的触发不补跑：启动时把过期的 nextRunAt 静默推进到未来。
 */

export type CronLifecycle = 'active' | 'paused' | 'completed' | 'failed'

export interface CronSchedule {
  unit: 'minute' | 'day' | 'week' | 'month'
  /** minute：每 N 分钟（锚定创建时刻）；其余：每 N 天/周/月。 */
  interval: number
  /** day/week/month 的触发时刻。 */
  hour?: number
  minute?: number
  /** week 生效，0-6（0=周日），与 JS Date.getDay() 同约定。 */
  weekdays?: number[]
  /** month 生效，1-28（避开缺 30/31 日的月份）。 */
  monthDay?: number
  /** 系列锚点（创建时刻，毫秒）；「每 N 分钟」与周/月窗口都从它起算。 */
  anchorAt: number
}

export interface CronTask {
  id: string
  title: string
  prompt: string
  /** default = fi 隐藏默认工作区（普通模式任务清单）；folder = 指定项目文件夹。 */
  targetKind: 'default' | 'folder'
  workspacePath: string | null
  schedule: CronSchedule
  /** true=无限循环；false=跑满 maxRuns 次转 completed。 */
  recurring: boolean
  maxRuns: number | null
  enabled: boolean
  lifecycleStatus: CronLifecycle
  nextRunAt: number | null
  lastRunAt: number | null
  runCount: number
  lastError: string | null
  lastSessionId: string | null
  createdAt: number
  updatedAt: number
}

/** 面板新建/编辑提交的载荷；字段合法性由 validateDraft 统一把关。 */
export interface CronTaskDraft {
  title: string
  prompt: string
  targetKind: 'default' | 'folder'
  workspacePath?: string | null
  schedule: {
    unit: CronSchedule['unit']
    interval: number
    at?: string
    weekdays?: number[]
    monthDay?: number
  }
  recurring: boolean
  maxRuns?: number | null
}

const PROFILE_NAME = 'fi'
const SWEEP_INTERVAL_MS = 30_000
const TASK_LIMIT = 20
const MINUTE = 60_000
const DAY_MS = 24 * 60 * MINUTE

function clampInt(value: number, min: number, max: number): number {
  const n = Math.floor(value)
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min))
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

// ---------------------------------------------------------------------------
// 调度计算（纯函数；「每 N 分钟」按 anchorAt 对齐，日/周/月按锚点日历窗口）
// ---------------------------------------------------------------------------

/**
 * 严格晚于 from 的下一次触发时刻；null = 系列尽头（约 10 年量级的防御上限，
 * 正常配置不会触达）。跨夏令时的时间用固定 24h 步长近似，中国时区无影响。
 */
export function computeNextRunAt(s: CronSchedule, from: number): number | null {
  if (s.unit === 'minute') {
    const step = Math.max(1, s.interval) * MINUTE
    // 严格晚于 from：from==anchorAt（刚创建）时取 anchor+interval，不能立即到期。
    if (from < s.anchorAt) return s.anchorAt
    const k = Math.floor((from - s.anchorAt) / step) + 1
    return s.anchorAt + k * step
  }
  const hour = clampInt(s.hour ?? 9, 0, 23)
  const minute = clampInt(s.minute ?? 0, 0, 59)
  const atTime = (year: number, month: number, day: number) =>
    new Date(year, month, day, hour, minute, 0, 0).getTime()
  if (s.unit === 'day') {
    const n = Math.max(1, s.interval)
    const anchor = new Date(s.anchorAt)
    anchor.setHours(hour, minute, 0, 0)
    for (let k = 0; k < 4000; k++) {
      const t = anchor.getTime() + k * n * DAY_MS
      if (t > from) return t
    }
    return null
  }
  if (s.unit === 'week') {
    const n = Math.max(1, s.interval)
    const weekdays = (s.weekdays && s.weekdays.length > 0 ? s.weekdays : [1])
      .map((d) => clampInt(d, 0, 6))
      .sort((a, b) => a - b)
    const anchor = new Date(s.anchorAt)
    anchor.setHours(0, 0, 0, 0)
    // 以锚点日为第一天的 7 天窗口算「第 1 周」，窗口内落在所选星期上的时刻生效。
    for (let d = 0; d < 4000; d++) {
      if (Math.floor(d / 7) % n !== 0) continue
      const date = new Date(anchor.getTime() + d * DAY_MS)
      if (!weekdays.includes(date.getDay())) continue
      const t = atTime(date.getFullYear(), date.getMonth(), date.getDate())
      if (t > from) return t
    }
    return null
  }
  const n = Math.max(1, s.interval)
  const monthDay = clampInt(s.monthDay ?? 1, 1, 28)
  const anchor = new Date(s.anchorAt)
  for (let k = 0; k < 1200; k++) {
    const t = atTime(anchor.getFullYear(), anchor.getMonth() + k * n, monthDay)
    if (t > from) return t
  }
  return null
}

/** 校验面板草稿并归一化为合法 schedule；返回错误文案（已本地化为面板语言）。 */
export function normalizeSchedule(
  raw: CronTaskDraft['schedule'],
  anchorAt: number,
): { ok: true; schedule: CronSchedule } | { ok: false; error: string } {
  const unit = raw.unit
  if (!['minute', 'day', 'week', 'month'].includes(unit)) return { ok: false, error: 'invalid unit' }
  const interval = clampInt(Number(raw.interval), 1, 9999)
  if (!Number.isFinite(Number(raw.interval)) || interval < 1) {
    return { ok: false, error: 'interval must be >= 1' }
  }
  if (unit === 'minute') return { ok: true, schedule: { unit, interval, anchorAt } }
  const at = typeof raw.at === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(raw.at.trim()) : null
  if (at === null) return { ok: false, error: 'time must be HH:MM' }
  const hour = clampInt(Number(at[1]), 0, 23)
  const minute = clampInt(Number(at[2]), 0, 59)
  if (unit === 'week') {
    const weekdays = (raw.weekdays ?? []).map((d) => clampInt(Number(d), 0, 6))
    if (weekdays.length === 0) return { ok: false, error: 'week requires weekdays' }
    return { ok: true, schedule: { unit, interval, hour, minute, weekdays, anchorAt } }
  }
  if (unit === 'month') {
    return { ok: true, schedule: { unit, interval, hour, minute, monthDay: clampInt(Number(raw.monthDay ?? 1), 1, 28), anchorAt } }
  }
  return { ok: true, schedule: { unit, interval, hour, minute, anchorAt } }
}

// ---------------------------------------------------------------------------
// dsh web API 连接（握手 URL → token 换 cookie → /api/<ns>/<method>）
// ---------------------------------------------------------------------------

/** 与 dsh-process.ts / 插件服务端半层同一约定：DSH_HOME 覆盖默认 ~/.dsh。 */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** fi 普通模式背后的隐藏默认工作区（标题 default，由插件服务端半层创建）。 */
function defaultWorkspaceDir(): string {
  return join(dshHome(), 'workspace-default')
}

interface RpcResult<T> {
  type: string
  result?: { ok: boolean; value?: T; error?: { code: string; message: string } }
}

class DshApi {
  private origin: string | null = null
  private token: string | null = null
  private cookie: string | null = null

  get available(): boolean {
    return this.origin !== null
  }

  attach(url: string): void {
    const parsed = new URL(url)
    this.origin = parsed.origin
    this.token = parsed.searchParams.get('token')
    this.cookie = null
  }

  reset(): void {
    this.origin = null
    this.token = null
    this.cookie = null
  }

  /** 连接未就绪（dsh 未起/重启中）时返回 false，调用方跳过本轮且不记失败。 */
  private async ensureCookie(): Promise<boolean> {
    if (this.origin === null || this.token === null) return false
    try {
      const res = await fetch(`${this.origin}/?token=${encodeURIComponent(this.token)}`, {
        redirect: 'manual',
      })
      const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
      this.cookie = cookies.length > 0 ? cookies.map((c) => c.split(';')[0]).join('; ') : null
      return this.cookie !== null
    } catch {
      return false
    }
  }

  async call<T>(endpoint: string, args: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.cookie === null) {
        if (!(await this.ensureCookie())) throw new Error('dsh 连接不可用')
      }
      let res: Response
      try {
        res = await fetch(`${this.origin}/api/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: this.cookie ?? '' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: randomUUID(),
            method: endpoint,
            payload: { args },
          }),
        })
      } catch (err) {
        this.cookie = null
        throw new Error(err instanceof Error ? err.message : String(err))
      }
      if (res.status === 401 || res.status === 403) {
        this.cookie = null
        continue
      }
      const body = (await res.json().catch(() => null)) as RpcResult<T> | null
      if (body === null || body.type !== 'server-response' || body.result === undefined) {
        throw new Error('dsh API 响应格式异常')
      }
      if (!body.result.ok) {
        throw new Error(body.result.error?.message || body.result.error?.code || 'dsh API 调用失败')
      }
      return body.result.value as T
    }
    throw new Error('dsh 认证失败')
  }
}

// ---------------------------------------------------------------------------
// 派发
// ---------------------------------------------------------------------------

interface WorkspaceValue {
  workspace: { workspaceId: string }
}

async function dispatchTask(api: DshApi, task: CronTask): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const wsPath = task.targetKind === 'default' ? defaultWorkspaceDir() : task.workspacePath ?? ''
  if (!isAbsolute(wsPath)) return { ok: false, error: '工作区路径无效' }
  try {
    const ws = await api.call<WorkspaceValue>('workspace/create', {
      request: { path: wsPath, title: task.targetKind === 'default' ? 'default' : basename(wsPath) },
    })
    const created = await api.call<{ sessionId: string }>('session/create', {
      request: { workspaceId: ws.workspace.workspaceId },
    })
    await api.call('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: task.prompt }],
      },
    })
    return { ok: true, sessionId: created.sessionId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// 存储与调度器
// ---------------------------------------------------------------------------

function storagePath(): string {
  return join(dshHome(), 'profiles', PROFILE_NAME, 'fi-cron-tasks.json')
}

function isCronLifecycle(value: unknown): value is CronLifecycle {
  return value === 'active' || value === 'paused' || value === 'completed' || value === 'failed'
}

/** 读文件容错：缺失/损坏都从空表开始（损坏时保留坏文件旁路，避免覆盖排查现场）。 */
async function loadTasks(): Promise<CronTask[]> {
  try {
    const raw = await fs.readFile(storagePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is CronTask => {
      const t = item as CronTask
      return typeof t?.id === 'string' && typeof t?.prompt === 'string' && isCronLifecycle(t?.lifecycleStatus)
    })
  } catch {
    return []
  }
}

async function saveTasks(tasks: CronTask[]): Promise<void> {
  const path = storagePath()
  await fs.mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf8')
  await fs.rename(tmp, path)
}

class CronScheduler {
  private tasks: CronTask[] = []
  private loaded = false
  private sweeping = false
  private readonly inFlight = new Set<string>()
  private readonly api = new DshApi()

  constructor(private readonly dsh: DshProcess) {
    // 兜底：若注册时握手 URL 已就绪（如 FI_DSH_URL 直连），直接附着。
    if (dsh.url !== null) this.api.attach(dsh.url)
    dsh.on('url', (url: string) => this.api.attach(url))
    dsh.on('state', (state: string) => {
      // 重启/失败/停止期间连接不可用：fire 跳过且不记失败，dsh 恢复后下轮补派。
      if (state !== 'ready') this.api.reset()
    })
  }

  async start(): Promise<void> {
    await this.reload()
    setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
    void this.sweep()
  }

  private async reload(): Promise<void> {
    const tasks = await loadTasks()
    // 错过的触发不补跑：启动时把过期计划推进到未来（paused/completed 不动）。
    const now = Date.now()
    for (const task of tasks) {
      if (task.enabled && task.lifecycleStatus === 'active' && task.nextRunAt !== null && task.nextRunAt <= now) {
        task.nextRunAt = computeNextRunAt(task.schedule, now)
      }
    }
    this.tasks = tasks
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await saveTasks(this.tasks)
  }

  private notify(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('fi:cron:changed', this.tasks)
    }
  }

  private async persistAndNotify(): Promise<void> {
    await this.persist().catch(() => {})
    this.notify()
  }

  private async sweep(): Promise<void> {
    if (this.sweeping || !this.loaded) return
    this.sweeping = true
    try {
      const now = Date.now()
      let fired = false
      for (const task of this.tasks) {
        if (!task.enabled || task.lifecycleStatus !== 'active') continue
        if (task.nextRunAt === null || task.nextRunAt > now) continue
        this.fire(task, now)
        fired = true
      }
      if (fired) await this.persist()
    } finally {
      this.sweeping = false
    }
  }

  /** 到点触发：先落计划侧（计数/推进/终态），派发异步进行；同任务在途则跳过本轮。 */
  private fire(task: CronTask, now: number): void {
    // dsh 未就绪（未起/重启中）：本轮不触发也不记失败，计划未动，下一轮重试。
    if (!this.api.available) return
    if (this.inFlight.has(task.id)) {
      task.nextRunAt = computeNextRunAt(task.schedule, now)
      return
    }
    task.runCount += 1
    task.lastRunAt = now
    const reachedMax = !task.recurring && task.runCount >= (task.maxRuns ?? 1)
    task.nextRunAt = reachedMax ? null : computeNextRunAt(task.schedule, now)
    if (reachedMax || task.nextRunAt === null) {
      task.lifecycleStatus = 'completed'
      task.enabled = false
    }
    this.inFlight.add(task.id)
    void (async () => {
      try {
        const result = await dispatchTask(this.api, task)
        if (result.ok) {
          task.lastSessionId = result.sessionId
          task.lastError = null
        } else if (task.recurring) {
          // 循环任务保持调度（下轮照常），失败痕迹走徽章口径。
          task.lastError = result.error
        } else {
          // 一次性/有限计划：派发失败转 failed（可重新启用=重启）。
          task.lifecycleStatus = 'failed'
          task.enabled = false
          task.lastError = result.error
        }
      } finally {
        this.inFlight.delete(task.id)
        await this.persistAndNotify()
      }
    })()
  }

  list(): CronTask[] {
    return this.tasks
  }

  /** 立即运行：走同一条派发链，不动计划与计数；返回错误文案或 null。 */
  async runNow(id: string): Promise<string | null> {
    const task = this.tasks.find((t) => t.id === id)
    if (task === undefined) return '任务不存在'
    if (this.inFlight.has(id)) return '上一轮仍在运行'
    this.inFlight.add(id)
    try {
      const result = await dispatchTask(this.api, task)
      if (!result.ok) return result.error
      task.lastSessionId = result.sessionId
      await this.persistAndNotify()
      return null
    } finally {
      this.inFlight.delete(id)
    }
  }

  async create(draft: CronTaskDraft): Promise<CronTask | string> {
    if (this.tasks.length >= TASK_LIMIT) return `最多 ${TASK_LIMIT} 个定时任务`
    const error = validateCommon(draft)
    if (error !== null) return error
    const now = Date.now()
    const schedule = normalizeSchedule(draft.schedule, now)
    if (!schedule.ok) return schedule.error
    const task: CronTask = {
      id: randomUUID(),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      targetKind: draft.targetKind,
      workspacePath: draft.targetKind === 'folder' ? draft.workspacePath?.trim() ?? null : null,
      schedule: schedule.schedule,
      recurring: draft.recurring,
      maxRuns: draft.recurring ? null : clampInt(Number(draft.maxRuns ?? 1), 1, 9999),
      enabled: true,
      lifecycleStatus: 'active',
      nextRunAt: computeNextRunAt(schedule.schedule, now),
      lastRunAt: null,
      runCount: 0,
      lastError: null,
      lastSessionId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.push(task)
    await this.persistAndNotify()
    return task
  }

  async update(id: string, draft: CronTaskDraft): Promise<CronTask | string> {
    const task = this.tasks.find((t) => t.id === id)
    if (task === undefined) return '任务不存在'
    const error = validateCommon(draft)
    if (error !== null) return error
    const schedule = normalizeSchedule(draft.schedule, Date.now())
    if (!schedule.ok) return schedule.error
    task.title = draft.title.trim()
    task.prompt = draft.prompt.trim()
    task.targetKind = draft.targetKind
    task.workspacePath = draft.targetKind === 'folder' ? draft.workspacePath?.trim() ?? null : null
    task.schedule = schedule.schedule
    task.recurring = draft.recurring
    task.maxRuns = draft.recurring ? null : clampInt(Number(draft.maxRuns ?? 1), 1, 9999)
    task.updatedAt = Date.now()
    // 计划重算：改过调度即按现在重排；跑满的计划恢复有余量时复活为 active
    // （对齐 ZCode「原为终态、编辑后可跑 → 复活」）。
    const reachedMax = !task.recurring && task.runCount >= (task.maxRuns ?? 1)
    if (task.lifecycleStatus === 'completed' || task.lifecycleStatus === 'failed') {
      if (!reachedMax) {
        task.lifecycleStatus = 'active'
        task.enabled = true
        task.nextRunAt = computeNextRunAt(task.schedule, Date.now())
      }
    } else if (reachedMax) {
      task.lifecycleStatus = 'completed'
      task.enabled = false
      task.nextRunAt = null
    } else if (task.lifecycleStatus === 'active') {
      task.nextRunAt = computeNextRunAt(task.schedule, Date.now())
    }
    await this.persistAndNotify()
    return task
  }

  async delete(id: string): Promise<void> {
    this.tasks = this.tasks.filter((t) => t.id !== id)
    await this.persistAndNotify()
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const task = this.tasks.find((t) => t.id === id)
    if (task === undefined) return
    if (task.lifecycleStatus === 'completed') return // 自然终态不可启停
    if (task.lifecycleStatus === 'failed') {
      if (!enabled) return // 失败态本就停用
      // failed 的重新启用 = ZCode 的 restart：回 active、清错误、重排下一次。
      // 但计划已耗尽（有限任务失败时计数已落）的不能复活，落回 completed。
      task.lastError = null
      if (!task.recurring && task.runCount >= (task.maxRuns ?? 1)) {
        task.lifecycleStatus = 'completed'
        task.enabled = false
        task.nextRunAt = null
      } else {
        task.lifecycleStatus = 'active'
        task.enabled = true
        task.nextRunAt = computeNextRunAt(task.schedule, Date.now())
      }
    } else {
      task.enabled = enabled
      task.lifecycleStatus = enabled ? 'active' : 'paused'
      if (enabled && (task.nextRunAt === null || task.nextRunAt <= Date.now())) {
        task.nextRunAt = computeNextRunAt(task.schedule, Date.now())
      }
    }
    task.updatedAt = Date.now()
    await this.persistAndNotify()
  }

  async pickFolder(): Promise<string | null> {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    const result = win !== undefined
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  }
}

function validateCommon(draft: CronTaskDraft): string | null {
  if (typeof draft.title !== 'string' || draft.title.trim() === '') return '标题不能为空'
  if (typeof draft.prompt !== 'string' || draft.prompt.trim() === '') return '提示词不能为空'
  if (draft.targetKind === 'folder' && !(typeof draft.workspacePath === 'string' && isAbsolute(draft.workspacePath.trim()))) {
    return '请选择项目文件夹'
  }
  return null
}

// ---------------------------------------------------------------------------
// IPC 面
// ---------------------------------------------------------------------------

export function registerCronBridge(dsh: DshProcess): void {
  const scheduler = new CronScheduler(dsh)

  ipcMain.handle('fi:cron:list', () => ({ ok: true, tasks: scheduler.list() }))
  ipcMain.handle('fi:cron:create', (_event, draft: unknown) => guard(() => wrap(scheduler.create(draft as CronTaskDraft))))
  ipcMain.handle('fi:cron:update', (_event, payload: { id: string; draft: CronTaskDraft }) =>
    guard(() => wrap(scheduler.update(payload.id, payload.draft))))
  ipcMain.handle('fi:cron:delete', (_event, id: string) => guard(() => scheduler.delete(id).then(() => null)))
  ipcMain.handle('fi:cron:setEnabled', (_event, payload: { id: string; enabled: boolean }) =>
    guard(() => scheduler.setEnabled(payload.id, payload.enabled).then(() => null)))
  ipcMain.handle('fi:cron:runNow', (_event, id: string) => guard(() => scheduler.runNow(id)))
  ipcMain.handle('fi:cron:pickFolder', async () => {
    try {
      return { ok: true, path: await scheduler.pickFolder() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('fi:cron:defaultDir', () => ({ ok: true, path: defaultWorkspaceDir() }))

  void scheduler.start()
}

async function guard(fn: () => Promise<string | null>): Promise<{ ok: boolean; error?: string }> {
  try {
    const error = await fn()
    return error === null ? { ok: true } : { ok: false, error }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** create/update 返回任务或错误文案；IPC 层统一折叠为 {ok, task|error}。 */
function wrap(result: Promise<CronTask | string>): Promise<string | null> {
  return result.then((value) => (typeof value === 'string' ? value : null))
}
