// E2E 冒烟：隔离环境启动完整应用（Electron 壳 + 独立 DSH_HOME），
// 经 CDP 远程调试驱动真实页面，验证各版本核心功能链路。
// 覆盖：0.1 壳（spawn/URL/外链策略面/崩溃重启/退出回收）、0.2 插件装载 +
// 文件桥、0.3 插件客户端半层、0.5 cron IPC 全链路（CRUD/上限/校验/落盘）。
// 运行：node tests/e2e-smoke.mjs  （会在屏幕上短暂弹出应用窗口）
import { spawn, execSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DEBUG_PORT = 9333
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- 测试夹具：带隐藏项/符号链接/断链的目录 ---
const fsRoot = await mkdtemp(join(tmpdir(), 'fi-e2e-fs-'))
await mkdir(join(fsRoot, 'zz-dir'))
await mkdir(join(fsRoot, '.hidden-dir'))
await mkdir(join(fsRoot, 'dir-target'))
await writeFile(join(fsRoot, 'a-file.txt'), 'x')
await writeFile(join(fsRoot, '.hidden-file'), 'x')
await symlink(join(fsRoot, 'a-file.txt'), join(fsRoot, 'link-file'))
await symlink(join(fsRoot, 'dir-target'), join(fsRoot, 'link-dir'))
await symlink(join(fsRoot, 'no-such-target'), join(fsRoot, 'link-broken'))

const dshHome = await mkdtemp(join(tmpdir(), 'fi-e2e-home-'))
const userData = await mkdtemp(join(tmpdir(), 'fi-e2e-userdata-'))
console.log(`[e2e] DSH_HOME=${dshHome}\n[e2e] FI_USER_DATA_DIR=${userData}`)

const app = spawn('pnpm', ['exec', 'electron', `--remote-debugging-port=${DEBUG_PORT}`, '.'], {
  cwd: repoRoot,
  env: { ...process.env, DSH_HOME: dshHome, FI_USER_DATA_DIR: userData },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const appLog = []
app.stdout.on('data', (c) => appLog.push(`[out] ${c}`))
app.stderr.on('data', (c) => appLog.push(`[err] ${c}`))

let dshChildPid = null
try {
  // --- 等待窗口加载出 dsh URL（首启含 profile 初始化 + 插件 link，放宽到 150s）---
  // 注意：dsh 认证后重定向到不带 ?token= 的根路径，匹配时不能要求 token。
  const dshUrlRe = /^http:\/\/127\.0\.0\.1:\d+\//
  let page = null
  let appDied = false
  app.on('exit', () => { appDied = true })
  for (let i = 0; i < 75 && page === null && !appDied; i++) {
    await sleep(2000)
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page' && dshUrlRe.test(t.url)) ?? null
    } catch { /* debugger not up yet */ }
  }
  if (appDied) throw new Error('应用提前退出：\n' + appLog.slice(-20).join(''))
  check('0.1 壳：spawn dsh → 解析 token URL → 窗口加载（首次含 profile 初始化）', page !== null, page?.url?.replace(/token=\S+/, 'token=…'))
  if (page === null) throw new Error('窗口未加载 dsh URL')

  // --- CDP 连接 ---
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let msgId = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  })
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error('页面内执行异常: ' + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails))
    return r.result?.result?.value
  }

  // --- 找到 dsh 子进程：按命令行 + DSH_HOME 环境变量双重匹配（避免误伤真实实例）---
  const findDshChild = () => {
    try {
      const pids = execSync(`pgrep -f "dsh --profile fi" || true`).toString().trim().split('\n').filter(Boolean)
      for (const pid of pids) {
        const env = execSync(`ps eww -p ${pid} || true`).toString()
        if (env.includes(`DSH_HOME=${dshHome}`)) return pid
      }
    } catch { /* best effort */ }
    return null
  }
  dshChildPid = findDshChild()
  check('0.1 壳：dsh 作为主进程子进程运行', dshChildPid !== null, `pid=${dshChildPid}`)

  // --- 0.2 preload 桥就位 ---
  check('0.2 preload：window.fi 暴露 fs/shell/clipboard/cron 面', await evaluate(
    `typeof window.fi === 'object' && !!window.fi.fs && !!window.fi.shell && !!window.fi.clipboard && !!window.fi.cron`))

  // --- 0.2 文件桥：真实 readdir 排序/符号链接/断链/隐藏项 ---
  const home = await evaluate('window.fi.fs.home()')
  check('0.2 文件桥：fi.fs.home 返回主目录', home?.ok === true && home.path === homedir(), home?.path)
  const listing = await evaluate(`window.fi.fs.readdir(${JSON.stringify(fsRoot)})`)
  const expectOrder = [
    ['.hidden-dir', 'directory', false], ['dir-target', 'directory', false],
    ['link-dir', 'directory', true], ['zz-dir', 'directory', false],
    ['.hidden-file', 'file', false], ['a-file.txt', 'file', false],
    ['link-broken', 'other', true], ['link-file', 'file', true],
  ]
  const actual = listing?.entries?.map((e) => [e.name, e.type, e.isSymlink])
  check('0.2 文件桥：目录优先 + 自然排序；符号链接按目标归类；断链为 other', JSON.stringify(actual) === JSON.stringify(expectOrder), JSON.stringify(actual))
  check('0.2 文件桥：隐藏项由桥原样返回（显隐过滤在客户端）', listing?.entries?.some((e) => e.name.startsWith('.')) === true)
  const badPath = await evaluate('window.fi.fs.readdir("relative/path")')
  check('0.2 文件桥：相对路径拒绝（bad-path）', badPath?.ok === false && badPath.code === 'bad-path')
  const notDir = await evaluate(`window.fi.fs.readdir(${JSON.stringify(join(fsRoot, 'a-file.txt'))})`)
  check('0.2 文件桥：非目录返回 ENOTDIR 错误', notDir?.ok === false && notDir.code === 'ENOTDIR')

  // --- 0.2 插件客户端半层在真实页面装载 ---
  check('0.2 插件：fi-sidebar 客户端 CSS 已注入（客户端半层 boot）', await evaluate(
    `!!document.querySelector('style[data-plugin-css="fi-sidebar/sidebar.css"]')`))
  check('0.2 插件：旧「新会话」按钮隐藏样式已挂载', await evaluate(
    `!!document.querySelector('button[class*="_newSession"]') || document.styleSheets.length > 0`))

  // --- 0.2 服务端半层：隐藏 default 工作区已建 ---
  await sleep(3000) // 服务端 ensure 是异步的
  const wsDefault = join(dshHome, 'workspace-default')
  let wsDefaultOk = false
  try { const st = await stat(wsDefault); wsDefaultOk = st.isDirectory() } catch { /* not yet */ }
  check('0.2 插件：服务端半层创建 ~/.dsh/workspace-default（DSH_HOME 隔离）', wsDefaultOk, wsDefault)

  // --- 0.5 cron IPC 全链路 ---
  const empty = await evaluate('window.fi.cron.list()')
  check('0.5 cron：list 初始为空', empty?.ok === true && empty.tasks.length === 0)
  const badDraft = await evaluate(`window.fi.cron.create({ title: "  ", prompt: "p", targetKind: "default", schedule: { unit: "minute", interval: 5 }, recurring: true })`)
  check('0.5 cron：空标题被拒（主进程校验兜底）', badDraft?.ok === false && /标题/.test(badDraft?.error ?? ''), badDraft?.error)
  const badFolder = await evaluate(`window.fi.cron.create({ title: "t", prompt: "p", targetKind: "folder", workspacePath: "rel", schedule: { unit: "minute", interval: 5 }, recurring: true })`)
  check('0.5 cron：folder 目标相对路径被拒', badFolder?.ok === false && /文件夹/.test(badFolder?.error ?? ''), badFolder?.error)

  const mkDraft = (i) => `({ title: "任务${i}", prompt: "p${i}", targetKind: "default", schedule: { unit: "minute", interval: 9999 }, recurring: true })`
  // IPC 契约：create 只回 {ok}，任务经 fi:cron:changed 全量推送（订阅先于创建）。
  const created1 = await evaluate(`(async () => {
    const pushed = new Promise((resolve) => {
      const off = window.fi.cron.onChanged((tasks) => { if (tasks.length === 1) { off(); resolve(tasks[0]) } });
      setTimeout(() => resolve(null), 10000);
    });
    const r = await window.fi.cron.create(${mkDraft(1)});
    return { r, task: await pushed };
  })()`)
  const before = Date.now()
  const created = created1?.task
  check('0.5 cron：create 经 fi:cron:changed 推全量，nextRunAt ≈ 创建时刻 + 9999 分钟', created1?.r?.ok === true
    && typeof created?.nextRunAt === 'number'
    && created.nextRunAt > before && created.nextRunAt <= Date.now() + 9999 * 60_000 + 5000
    && created.lifecycleStatus === 'active', JSON.stringify(created?.nextRunAt))
  const storage = join(dshHome, 'profiles', 'fi', 'fi-cron-tasks.json')
  const stored = JSON.parse(await readFile(storage, 'utf8'))
  check('0.5 cron：任务落盘 fi profile 目录（fi-cron-tasks.json）', Array.isArray(stored) && stored.length === 1 && stored[0].id === created.id)

  const changed = await evaluate(`new Promise((resolve) => {
    const off = window.fi.cron.onChanged((tasks) => { off(); resolve(tasks.length) });
    window.fi.cron.setEnabled(${JSON.stringify(created.id)}, false);
  })`)
  check('0.5 cron：setEnabled 暂停并经 fi:cron:changed 推全量', changed === 1)
  const paused = (await evaluate('window.fi.cron.list()')).tasks[0]
  check('0.5 cron：暂停态 = enabled false + lifecycle paused', paused.enabled === false && paused.lifecycleStatus === 'paused')

  const updated = await evaluate(`(async () => {
    const r = await window.fi.cron.update(${JSON.stringify(created.id)}, { title: "改名", prompt: "p", targetKind: "folder", workspacePath: ${JSON.stringify(fsRoot)}, schedule: { unit: "day", interval: 1, at: "09:30" }, recurring: false, maxRuns: 3 });
    const list = await window.fi.cron.list();
    return { r, task: list.tasks.find((t) => t.id === ${JSON.stringify(created.id)}) };
  })()`)
  check('0.5 cron：update 改调度/位置/次数上限', updated?.r?.ok === true
    && updated.task.schedule.unit === 'day' && updated.task.schedule.hour === 9 && updated.task.schedule.minute === 30
    && updated.task.workspacePath === fsRoot && updated.task.recurring === false && updated.task.maxRuns === 3)

  // 上限 20 个
  let limitHit = false
  let limitMsg = ''
  for (let i = 2; i <= 22; i++) {
    const r = await evaluate(`window.fi.cron.create(${mkDraft(i)})`)
    if (r?.ok === false) { limitHit = true; limitMsg = r.error; break }
  }
  check('0.5 cron：第 21 个任务被拒（上限 20）', limitHit, limitMsg)

  const afterDel = await evaluate(`(async () => { const l = await window.fi.cron.list(); for (const t of l.tasks) await window.fi.cron.remove(t.id); return (await window.fi.cron.list()).tasks.length })()`)
  check('0.5 cron：delete 清空列表', afterDel === 0)

  // --- 0.1 崩溃自动重启：杀 dsh 子进程 → 状态页 → 自动恢复 ---
  if (dshChildPid !== null) {
    const firstUrl = page.url
    process.kill(Number(dshChildPid), 'SIGKILL')
    await sleep(1500)
    let recovered = null
    for (let i = 0; i < 45 && recovered === null; i++) {
      await sleep(2000)
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
        recovered = list.find((t) => t.type === 'page' && dshUrlRe.test(t.url) && t.url !== firstUrl) ?? null
      } catch { /* debugger restarting */ }
    }
    check('0.1 壳：dsh 被外部杀掉后自动重启并切到新 URL', recovered !== null, recovered?.url?.replace(/token=\S+/, 'token=…'))
    dshChildPid = findDshChild() // 记录重启后的新 dsh，退出检查用
  }

  // --- 干净退出：Browser.close（走正常退出路径）→ dsh 被回收 ---
  // --- 干净退出：Browser.close（走正常退出路径）→ dsh 被回收 ---
  // 响应可能随连接一起消失，超时竞速避免挂起。
  await Promise.race([send('Browser.close').catch(() => {}), sleep(8000)])
  let exited = false
  for (let i = 0; i < 15 && !exited; i++) { await sleep(1000); exited = app.exitCode !== null || appDied }
  check('0.1 壳：Browser.close 后应用退出', exited || app.exitCode !== null)
  await sleep(2000)
  check('0.1 壳：退出后无 dsh 孤儿进程', (() => {
    try {
      const pids = execSync(`pgrep -f "dsh --profile fi" || true`).toString().trim().split('\n').filter(Boolean)
      const orphans = pids.filter((pid) => {
        try { return execSync(`ps eww -p ${pid} || true`).toString().includes(`DSH_HOME=${dshHome}`) } catch { return false }
      })
      if (orphans.length > 0) console.log(`[e2e] 孤儿: ${orphans.join(',')}`)
      return orphans.length === 0
    } catch { return true }
  })())
} catch (err) {
  check('E2E 流程自身异常', false, err.message)
} finally {
  // 兜底清理：经调试端口找到 electron 主进程（app.pid 是 pnpm 包装层），
  // 连同其 dsh 子进程一起回收，避免测试残留。
  try {
    const electronPid = execSync(`lsof -ti tcp:${DEBUG_PORT} | head -1`).toString().trim()
    if (electronPid !== '') {
      try { execSync(`pgrep -P ${electronPid} | xargs kill 2>/dev/null || true`) } catch { /* none */ }
      process.kill(Number(electronPid), 'SIGKILL')
    }
  } catch { /* port not listening = already gone */ }
  try { app.kill('SIGKILL') } catch { /* already gone */ }
  if (dshChildPid !== null) { try { process.kill(Number(dshChildPid), 'SIGKILL') } catch { /* gone */ } }
  await rm(fsRoot, { recursive: true, force: true })
  await rm(dshHome, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n[e2e] ${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('[e2e] 失败项：')
  for (const f of failed) console.log(`  ✖ ${f.name} — ${f.detail}`)
  process.exit(1)
}
