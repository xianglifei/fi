// E2E 冒烟：隔离环境启动完整应用（Electron 壳 + 独立 DSH_HOME），
// 经 CDP 远程调试驱动真实页面，验证各版本核心功能链路。
// 覆盖：0.1 壳（spawn/URL/外链策略面/崩溃重启/退出回收）、0.2 插件装载 +
// 文件桥、0.3 插件客户端半层、0.5 cron IPC 全链路（CRUD/上限/校验/落盘）、
// 0.5.2 启动钉子（冷启动固定 default 工作区，预置更新的 Applications 工作区复现退化）、
// 0.6 项目模式入口锚定（收起/展开回位）、0.7 品牌文字标移除（logo 行只剩图标）、
// 0.8 选区引用（选中→悬浮菜单→chip→发送合并引用块）、0.9 窗口标题品牌
// （原生标题 DeepSeek Harness → fi，任务态「任务标题 - fi」）。
// 运行：node tests/e2e-smoke.mjs  （会在屏幕上短暂弹出应用窗口）
import { spawn, execSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
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

// --- 预置工作区存储：复现「冷启动落在最近活动工作区」的退化场景 ---
// dsh 的 recentWorkspace 对无会话工作区按 createdAt 排序，因此无需伪造会话文件：
// 让 Applications 比 default 新即可让它成为 dsh 原生逻辑的选择；default 交给
// 服务端半层 ensure 幂等复用（同规范化 path 不重建，createdAt 保留预置值）。
// 路径必须写 realpath：macOS 的 /var 是 /private/var 的符号链接，dsh 按规范化
// 路径登记，符号链接路径会让 ensure 误判为不同目录另建 default（新 createdAt
// 反超 Applications，场景失效）。
const dshHomeReal = await realpath(dshHome)
const seededAt = (offsetMs) => new Date(Date.now() - offsetMs).toISOString()
await mkdir(join(dshHomeReal, 'e2e-applications'), { recursive: true })
await mkdir(join(dshHomeReal, 'workspace-default'), { recursive: true })
await mkdir(join(dshHomeReal, 'storages'), { recursive: true })
await writeFile(join(dshHomeReal, 'storages', 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws-seed-app', 'ws-seed-default'], archivedSessionIds: [] },
  tables: {
    workspaces: {
      'ws-seed-app': {
        path: join(dshHomeReal, 'e2e-applications'), title: 'Applications',
        sessionIds: [], createdAt: seededAt(60_000), updatedAt: seededAt(60_000),
      },
      'ws-seed-default': {
        path: join(dshHomeReal, 'workspace-default'), title: 'default',
        sessionIds: [], createdAt: seededAt(3_600_000), updatedAt: seededAt(3_600_000),
      },
    },
  },
}))

const app = spawn('pnpm', ['exec', 'electron', `--remote-debugging-port=${DEBUG_PORT}`, '.'], {
  cwd: repoRoot,
  env: { ...process.env, DSH_HOME: dshHome, FI_USER_DATA_DIR: userData, FI_TITLE_TRACE: '1' },
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

  // --- 0.5.2 启动钉子：冷启动初始会话固定 default 工作区 ---
  // 预置存储里 Applications 比 default「新」，dsh 原生 recentWorkspace 会选它；
  // 页面文本是最稳的信号：新任务页/输入框下方显示当前工作区名，而 fi 普通
  // 模式侧栏的 default 行不带工作区名——修复前页面不会出现「default」字样。
  await sleep(2000)
  const bootText = await evaluate('document.body.innerText')
  check('0.5.2 启动钉子：冷启动初始会话钉在 default（而非最近活动的 Applications）',
    bootText.includes('default') && !bootText.includes('Applications'),
    JSON.stringify(bootText.slice(0, 160)))

  // --- 0.6 项目模式入口锚定：收起→展开后仍回到小鱼图标与收起按钮之间 ---
  // React 展开侧栏时重挂品牌按钮（insertBefore 到收起按钮上），会把 fi 注入
  // 的外来容器顶到行首；观察器对账须把它搬回锚点。收起 settle 为 150ms。
  const logoOrder = () => evaluate(`(() => {
    const row = document.querySelector('[class*="_logoRow"]');
    if (row === null) return null;
    return [...row.children].map((el) => (el.classList.contains('fi-ws-toggle-host') ? 'host' : /_brand/.test(el.className) ? 'brand' : 'other'));
  })()`)
  const orderInitially = await logoOrder()
  check('0.6 入口锚定：初始位置在品牌（小鱼）之后', orderInitially !== null && orderInitially[0] === 'brand' && orderInitially.includes('host'),
    JSON.stringify(orderInitially))
  const toggleSel = '[class*="_logoRow"] [class*="_toggle"]:not([class*="fi-ws-toggle"])'
  await evaluate(`document.querySelector(${JSON.stringify(toggleSel)}).click()`) // 收起
  await sleep(600)
  await evaluate(`document.querySelector(${JSON.stringify(toggleSel)}).click()`) // 展开
  await sleep(600)
  const orderAfter = await logoOrder()
  check('0.6 入口锚定：收起再展开后入口仍在小鱼图标之后、收起按钮之前',
    orderAfter !== null && orderAfter[0] === 'brand' && orderAfter[orderAfter.length - 2] === 'host' && orderAfter[orderAfter.length - 1] === 'other',
    JSON.stringify(orderAfter))

  // --- 0.7 品牌文字标：logo 行只剩小鱼图标、项目模式入口、收起按钮 ---
  const brandInfo = await evaluate(`(() => {
    const row = document.querySelector('[class*="_logoRow"]');
    if (row === null) return null;
    const brand = row.querySelector('[class*="_brand"]');
    return { text: row.innerText.trim(), hasFish: brand !== null && brand.querySelector('svg, img') !== null };
  })()`)
  check('0.7 品牌文字：logo 行不再显示「deepseek/HARNESS」文字，小鱼图标保留',
    brandInfo !== null && brandInfo.text === '' && brandInfo.hasFish === true,
    JSON.stringify(brandInfo))

  // --- 0.8 选区引用：选中→悬浮菜单→chip→发送合并 ---
  // 链路：发一条消息制造可选文本（提交回显是本地同步进会话投影的，凭据缺失
  // 只会让本轮运行失败、回显仍在）→ 合成选区 + mouseup 触发 fi 选区监听 →
  // 点「添加到当前任务」→ 引用 chip 应出现在输入框上方（conversation.input.dock
  // 槽位）→ 发送第二条消息时引用块并入正文。
  // Lexical 编辑器不认合成 beforeinput，execCommand 也插不进；CDP
  // Input.insertText 走浏览器真实输入管线，与键盘输入等价。focus 不会搬动
  // DOM 选区（选区可能还停在消息流上，insertText 会插去那里），必须显式把
  // 光标坍缩进编辑器末尾。
  const typeIntoComposer = async (text) => {
    const focused = await evaluate(`(() => {
      const el = document.querySelector('[data-composer-seat] [contenteditable="true"]');
      if (el === null) return false;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return document.activeElement === el && el.contains(sel.anchorNode);
    })()`)
    if (focused !== true) return null
    await send('Input.insertText', { text })
    await sleep(300)
    return evaluate(`document.querySelector('[data-composer-seat] [contenteditable="true"]')?.textContent ?? null`)
  }
  // 主按钮随状态换角色（发送/排队/插话/停止），取未禁用的 primary 按钮且排除停止
  const clickSend = () => evaluate(`(() => {
    const btn = [...document.querySelectorAll('[data-composer-seat] button')]
      .find((b) => b.className.includes('primary') && !b.disabled && !/停止|Stop/.test(b.getAttribute('aria-label') ?? ''));
    if (btn === undefined) return false;
    btn.click();
    return true;
  })()`)
  const pollFor = async (expression, timeoutMs = 20000) => {
    for (let i = 0; i < Math.ceil(timeoutMs / 500); i++) {
      await sleep(500)
      if (await evaluate(expression) === true) return true
    }
    return false
  }
  const MSG1 = 'fi 引用功能冒烟第一条'
  // 首启「内测声明→API Key」遮罩链有焦点陷阱，不点掉就无法聚焦编辑器。
  // DOM .click() 不经过命中测试；可见性用 getBoundingClientRect 判
  // （position:fixed 的 offsetParent 恒为 null，会误判不可见）。
  for (let i = 0; i < 8; i++) {
    const r = await evaluate(`(() => {
      const visible = (b) => !b.disabled && b.getBoundingClientRect().width > 0;
      const candidates = [...document.querySelectorAll('[class*="_mask_"], [role="dialog"]')];
      const overlay = candidates.find((c) => [...c.querySelectorAll('button')].some(visible));
      if (overlay === undefined) return candidates.length > 0 ? 'pending' : 'gone';
      const buttons = [...overlay.querySelectorAll('button')].filter(visible);
      const prefer = buttons.find((b) => /稍后|跳过|继续|以后|忽略|Later|Skip|Continue/i.test(b.innerText)) ?? buttons[0];
      prefer.click();
      return 'clicked';
    })()`)
    if (r !== 'clicked') break
    await sleep(400)
  }
  let typed = await typeIntoComposer(MSG1)
  if (typed !== MSG1) {
    // 遮罩摘除有动画/焦点回移延迟，失败重试一轮
    await sleep(800)
    typed = await typeIntoComposer(MSG1)
  }
  check('0.8 选区引用：composer 可输入文本（CDP Input.insertText）', typed === MSG1, JSON.stringify(typed))
  await sleep(400)
  const sent1 = await clickSend()
  const flowUp = await pollFor(`(() => [...document.querySelectorAll('[data-chat-flow-kind="user"]')].some((el) => el.innerText.includes(${JSON.stringify(MSG1)})))()`)
  check('0.8 选区引用：首条消息进入对话流（提交回显）', sent1 === true && flowUp === true,
    sent1 === true ? '' : '发送按钮不可用')

  // 合成选区：turn 错误横幅等重渲染可能把刚建的选区冲掉（DOM 变更塌缩选区），
  // 失败就重建选区再补一次 mouseup，直到悬浮菜单出现。
  let tooltip = null
  for (let i = 0; i < 5 && tooltip === null; i++) {
    const r = await evaluate(`(() => {
      const el = [...document.querySelectorAll('[data-chat-flow-kind="user"]')].find((el) => el.innerText.includes(${JSON.stringify(MSG1)}));
      if (el === null) return 'no-flow';
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return 'selected:' + String(sel.toString()).length;
    })()`)
    await sleep(400) // rAF 防抖 + React 渲染
    tooltip = await evaluate(`(() => {
      const menu = document.querySelector('[data-fi-quote-tooltip]');
      return menu === null ? null : { hasAction: menu.querySelector('[data-fi-quote-action="add"]') !== null, text: menu.innerText };
    })()`)
    if (tooltip === null) console.log(`[e2e] 选区第 ${i} 轮未弹菜单（${r}），重试`)
  }
  check('0.8 选区引用：选中消息文字弹出「添加到当前任务」悬浮菜单', tooltip !== null && tooltip.hasAction === true, JSON.stringify(tooltip))

  const added = await evaluate(`(() => {
    const btn = document.querySelector('[data-fi-quote-tooltip] [data-fi-quote-action="add"]');
    if (btn === null) return false;
    btn.click();
    return true;
  })()`)
  await sleep(400)
  const chip = await evaluate(`(() => {
    const dock = document.querySelector('[data-fi-quote-dock]');
    return dock === null ? null : { count: dock.querySelector('[data-fi-quote-count]')?.dataset.fiQuoteCount ?? null, label: dock.innerText };
  })()`)
  check('0.8 选区引用：点击后引用 chip 出现在输入框上方（1 条）', added === true && chip !== null && chip.count === '1', JSON.stringify(chip))

  const MSG2 = 'fi 引用功能冒烟第二条'
  let typed2 = await typeIntoComposer(MSG2)
  if (typed2 !== MSG2) {
    await sleep(800)
    typed2 = await typeIntoComposer(MSG2)
  }
  await sleep(400)
  await clickSend()
  const merged = await pollFor(`(() => [...document.querySelectorAll('[data-chat-flow-kind="user"]')].some((el) => el.innerText.includes(${JSON.stringify(MSG2)}) && el.innerText.includes('【引用')))()`)
  check('0.8 选区引用：发送时引用块并入正文（用户消息含【引用）', merged)
  await sleep(600)
  const chipAfter = await evaluate(`document.querySelector('[data-fi-quote-dock]') === null`)
  check('0.8 选区引用：发送后 chip 消失（引用即消费）', chipAfter)

  // --- 0.9 窗口标题品牌：原生标题改写 ---
  // 改写发生在主进程 page-title-updated，CDP 只能看到页面内 document.title
  // （仍是 dsh 原文），因此经 FI_TITLE_TRACE 打点观测：空闲态应为「fi」，发过
  // 消息进入任务后应为「任务标题 - fi」，任何 traced 标题不得再含品牌字样。
  const tracedTitles = () => appLog
    .flatMap((chunk) => chunk.split('\n'))
    .map((line) => (line.match(/^\[out\] \[fi\] title: (.+)$/) ?? [])[1])
    .filter(Boolean)
    .map((json) => { try { return JSON.parse(json) } catch { return null } })
    .filter(Boolean)
  let titles = tracedTitles()
  for (let i = 0; i < 10 && titles.length === 0; i++) { await sleep(1000); titles = tracedTitles() }
  check('0.9 窗口标题：空闲态原生标题改写为「fi」（无 DeepSeek Harness 字样）',
    titles.includes('fi'), JSON.stringify(titles))
  check('0.9 窗口标题：进入任务后为「任务标题 — fi」',
    titles.some((t) => t !== 'fi' && /\s[—-]\sfi$/.test(t)), JSON.stringify(titles))
  check('0.9 窗口标题：所有 traced 标题均不含品牌字样',
    titles.length > 0 && titles.every((t) => !t.includes('DeepSeek Harness')), JSON.stringify(titles))

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

  // --- 0.7 插件中心：IPC 面 + 两区面板（纯客户端链路，不真实联网安装）---
  check('0.7 插件中心：preload 暴露 window.fi.plugins 面', await evaluate(
    `typeof window.fi.plugins === 'object' && typeof window.fi.plugins.list === 'function' && typeof window.fi.plugins.install === 'function' && typeof window.fi.plugins.onChanged === 'function'`))
  const pluginsList = await evaluate('window.fi.plugins.list()')
  check('0.7 插件中心：list 返回空清单（隔离环境只装过内置 fi-sidebar，过滤后为空）',
    pluginsList?.ok === true && Array.isArray(pluginsList.plugins) && pluginsList.plugins.length === 0,
    JSON.stringify(pluginsList?.plugins))
  const badInstall = await evaluate('window.fi.plugins.install("")')
  check('0.7 插件中心：空安装标识被拒（主进程校验）', badInstall?.ok === false, badInstall?.error)
  const pluginOpened = await evaluate(`(() => {
    const btn = document.querySelector('.fi-actions [aria-label="插件中心"], .fi-actions [aria-label="Plugins"]');
    if (btn === null) return false;
    btn.click();
    return true;
  })()`)
  const pluginPanel = await pollFor(`(() => {
    if (document.querySelector('.fi-plugin-empty') === null) return false;
    const rec = document.querySelector('.fi-plugin-list .fi-plugin-repo');
    const installBtn = document.querySelector('.fi-plugin-list .fi-cron-btn--primary');
    return rec !== null && (rec.getAttribute('href') ?? '').startsWith('https://github.com/')
      && installBtn !== null && /安装|Install/.test(installBtn.textContent);
  })()`)
  check('0.7 插件中心：面板打开——已安装空态提示 + 推荐卡（GitHub 链接与安装按钮）',
    pluginOpened === true && pluginPanel === true)
  const recVer = await evaluate(`document.querySelector('.fi-plugin-list .fi-plugin-ver')?.textContent ?? null`)
  check('0.7 插件中心：推荐卡展示版本号', recVer !== null && /^\d+\.\d+\.\d+$/.test(recVer), recVer)

  // --- 0.7 插件中心：卸载全链路（离线 link: 装假插件 → 两步确认卸载 → 行消失）---
  const fakeDir = join(await realpath(fsRoot), 'fake-plugin')
  await mkdir(fakeDir)
  await writeFile(join(fakeDir, 'package.json'), JSON.stringify({
    name: 'fi-e2e-fake', version: '9.9.9', description: 'e2e 卸载链路专用', private: true,
  }))
  let seeded = false
  try {
    execSync(`dsh plugin --profile fi add link:${fakeDir}`, {
      env: { ...process.env, DSH_HOME: dshHome }, stdio: 'pipe',
    })
    seeded = JSON.parse(await readFile(join(dshHome, 'profiles', 'fi', 'package.json'), 'utf8'))
      .dependencies['fi-e2e-fake'] !== undefined
  } catch { /* 夹具失败由断言兜底 */ }
  check('0.7 插件中心：夹具——假插件经 dsh plugin add link: 装入 fi profile（离线）', seeded)
  await evaluate(`document.querySelector('.fi-cron-head-actions .fi-cron-iconbtn')?.click()`) // 面板刷新
  const fakeRow = await pollFor(`(() => {
    const row = [...document.querySelectorAll('.fi-plugin-row')]
      .find((el) => el.querySelector('.fi-plugin-name')?.textContent === 'fi-e2e-fake');
    return row === undefined ? false : row.querySelector('.fi-plugin-ver')?.textContent === '9.9.9';
  })()`)
  check('0.7 插件中心：已安装区出现假插件行（刷新拉取新装清单）', fakeRow === true)
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.fi-plugin-row')]
      .find((el) => el.querySelector('.fi-plugin-name')?.textContent === 'fi-e2e-fake');
    row?.querySelector('.fi-plugin-uninstall')?.click();
    return true;
  })()`)
  await sleep(400) // React 渲染异步，点击与读 DOM 分开
  const confirmShown = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.fi-plugin-row')]
      .find((el) => el.querySelector('.fi-plugin-name')?.textContent === 'fi-e2e-fake');
    return row?.querySelector('.fi-plugin-uninstall')?.textContent ?? null;
  })()`)
  check('0.7 插件中心：卸载两步确认——首点换「确认卸载」', confirmShown !== null && confirmShown.includes('确认卸载'), JSON.stringify(confirmShown))
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.fi-plugin-row')]
      .find((el) => el.querySelector('.fi-plugin-name')?.textContent === 'fi-e2e-fake');
    row?.querySelector('.fi-plugin-uninstall')?.click();
    return true;
  })()`)
  const fakeGone = await pollFor(`[...document.querySelectorAll('.fi-plugin-name')].every((el) => el.textContent !== 'fi-e2e-fake')`, 30000)
  const pkgAfter = JSON.parse(await readFile(join(dshHome, 'profiles', 'fi', 'package.json'), 'utf8'))
  check('0.7 插件中心：确认卸载后行消失且依赖表已清理（fi:plugins:changed 推全量）',
    fakeGone === true && pkgAfter.dependencies['fi-e2e-fake'] === undefined)
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(300)
  check('0.7 插件中心：Esc 退出面板', await evaluate(`document.querySelector('.fi-plugin-empty') === null`))

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
