// 侧栏插件 fi-sidebar——模块加载 + 纯逻辑单元测试。
// 被测对象：dsh-plugin/lib/client.js（真实源码，在桩环境中加载后提取内部纯函数）。
// 覆盖：0.2 任务列表/搜索合并、0.4 图标表、0.5 面板筛选与调度文案、词典完整性。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../dsh-plugin/lib/client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// 桩环境加载：window.__ModuleLoader__.load 工厂在无 DOM/React 的环境里执行
// ---------------------------------------------------------------------------

function loadPlugin() {
  const loads = []
  const windowStub = { __ModuleLoader__: { load: (spec) => loads.push(spec) } }
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild() {} },
  }
  new Function('window', 'document', 'navigator', source)(windowStub, documentStub, {})
  assert.equal(loads.length, 1, '恰好注册一个模块')
  const spec = loads[0]
  const stubs = {
    react: { useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useMemo: (fn) => fn(), useCallback: (fn) => fn },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: {} },
    'react-dom': { createPortal: () => null },
    '@deepseek-ai/dsh-client-ui-primitives': { Tooltip: () => null },
  }
  return { id: spec.id, exports: spec.factory((name) => stubs[name]) }
}

function extractFn(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `源码中找到 function ${name}`)
  let depth = 0
  let i = source.indexOf('{', start)
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(start, j + 1) }
  }
  assert.fail(`括号配平失败: ${name}`)
}

/** 组装提取出的纯函数 + 依赖常量为可调用模块。 */
const pureFns = new Function(`
  const DEFAULT_WORKSPACE_TITLE = 'default';
  ${extractFn('format')}
  ${extractFn('deriveRows')}
  ${extractFn('deriveSearchRows')}
  ${extractFn('relativeTime')}
  ${extractFn('cronHasFailure')}
  ${extractFn('cronStatusKind')}
  ${extractFn('cronFilterKind')}
  ${extractFn('cronScheduleText')}
  ${extractFn('cronFutureRelative')}
  const pad2 = (v) => String(v).padStart(2, '0');
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  return { format, deriveRows, deriveSearchRows, relativeTime, cronHasFailure, cronStatusKind, cronFilterKind, cronScheduleText, cronFutureRelative };
`)()

// 从 apply() 里捕获真实词典（zh/en）
const plugin = loadPlugin()
const captured = {}
plugin.exports.apply({
  get: () => ({ list: { getSnapshot: () => ({ items: [] }) } }),
  effect: (fn) => fn(),
  locale: { register: (ns, dicts) => { captured.ns = ns; captured.dicts = dicts } },
  slots: { inject: (name, factory) => { captured.slotName = name; factory() }, register: () => ({}) },
})
const zh = captured.dicts.zh
const en = captured.dicts.en
const t = (key) => zh[key] ?? key

// ---------------------------------------------------------------------------
// 模块与接线
// ---------------------------------------------------------------------------

test('模块按 dsh 客户端模块格式注册，id 为 fi-sidebar', () => {
  assert.equal(plugin.id, 'fi-sidebar')
})

test('exports 声明的 inject 面与实现一致', () => {
  assert.deepEqual(plugin.exports.inject, ['slots', 'locale', 'uiWorkspace', 'workspaces', 'sessions'])
})

test('apply(): 注册 fiSidebar 词典 + 以 sidebar.workspaces 槽位影子接管', () => {
  assert.equal(captured.ns, 'fiSidebar')
  assert.equal(captured.slotName, 'sidebar.workspaces')
})

// ---------------------------------------------------------------------------
// 词典完整性（0.2–0.5 全部 UI 文案）
// ---------------------------------------------------------------------------

test('zh / en 词典键完全一致（无缺漏）', () => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys, `差集: ${zhKeys.filter((k) => !(k in en)).concat(enKeys.filter((k) => !(k in zh))).join(', ')}`)
})

test('源码里每个 t("…") 字面量键在两份词典中都存在', () => {
  const used = new Set()
  for (const m of source.matchAll(/\bt\("([a-zA-Z0-9.]+)"\)/g)) used.add(m[1])
  assert.ok(used.size > 80, `扫描到的键数量合理（实际 ${used.size}）`)
  for (const key of used) {
    assert.ok(key in zh, `zh 缺键: ${key}`)
    assert.ok(key in en, `en 缺键: ${key}`)
  }
})

test('cron.weekday.0–6 动态键齐全', () => {
  for (let d = 0; d <= 6; d++) {
    assert.ok(`cron.weekday.${d}` in zh && `cron.weekday.${d}` in en, `weekday ${d}`)
  }
})

// ---------------------------------------------------------------------------
// 0.4 图标表
// ---------------------------------------------------------------------------

function evalObject(varName) {
  const start = source.indexOf(`const ${varName} = {`)
  assert.ok(start >= 0, `找到 const ${varName}`)
  let depth = 0
  let i = source.indexOf('{', start)
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (depth === 0) return (0, eval)(`(${source.slice(i, j + 1)})`) }
  }
  assert.fail(`括号配平失败: ${varName}`)
}

test('ICONS 引用的名字全部在 LUCIDE_INNER 表中（0.4 全量 Lucide 化）', () => {
  const icons = evalObject('ICONS')
  const lucide = evalObject('LUCIDE_INNER')
  for (const [key, name] of Object.entries(icons)) {
    assert.ok(name in lucide, `ICONS.${key} = "${name}" 不在 LUCIDE_INNER`)
  }
  // CHANGELOG 0.4.0 点名的关键替换
  assert.equal(icons.plugins, 'blocks')
  assert.equal(icons.refresh, 'rotate-cw')
  assert.equal(icons.newTaskHere, 'message-circle-plus')
  // 0.5.0 点名的眼睛开关
  assert.equal(icons.eye, 'eye')
  assert.equal(icons.eyeClosed, 'eye-closed')
})

test('LUCIDE_INNER 每个 path 都是合法 SVG 片段（<path>/<circle>/<rect>）', () => {
  const lucide = evalObject('LUCIDE_INNER')
  assert.ok(Object.keys(lucide).length >= 18, '图标数量级合理')
  for (const [name, inner] of Object.entries(lucide)) {
    assert.match(inner, /^<(path|circle|rect)\b/, `${name} 以 SVG 图元开头`)
    assert.ok(/^\s*$/.test(inner.replace(/<[^>]+>/g, '')), `${name} 只含 SVG 标签`)
  }
})

// ---------------------------------------------------------------------------
// 0.2 任务列表（deriveRows）
// ---------------------------------------------------------------------------

const mkSession = (id, updatedAt, extra = {}) => ({
  id, updatedAt, origin: 'root', blank: false, displayTitle: `t-${id}`, ...extra,
})
const mkSnapshots = (sessionList, workspaceList) => ({
  sessions: { phase: 'ready', byId: Object.fromEntries(sessionList.map((s) => [s.id, s])), current: sessionList[0]?.id ?? null },
  workspaces: { phase: 'ready', items: workspaceList, archivedSessionIds: [] },
})

test('deriveRows: 快照未就绪返回 null', () => {
  assert.equal(pureFns.deriveRows({ phase: 'loading' }, { phase: 'ready' }), null)
})

test('deriveRows: default 工作区缺失返回空数组（退化为空列表）', () => {
  const { sessions, workspaces } = mkSnapshots([mkSession('a', 100)], [{ title: '别的工作区', sessionIds: ['a'] }])
  assert.deepEqual(pureFns.deriveRows(sessions, workspaces), [])
})

test('deriveRows: 按最近更新倒序；排除子代理/归档/非当前 blank；保留当前 blank', () => {
  const list = [
    mkSession('old', 100),
    mkSession('new', 300),
    mkSession('mid', 200),
    mkSession('sub', 400, { origin: 'subagent' }),
    mkSession('archived', 500, {}),
    mkSession('blank-other', 600, { blank: true }),
  ]
  const { sessions, workspaces } = mkSnapshots(list, [{ title: 'default', sessionIds: list.map((s) => s.id) }])
  sessions.byId['archived'].id = 'archived'
  workspaces.archivedSessionIds = ['archived']
  const rows = pureFns.deriveRows(sessions, workspaces)
  assert.deepEqual(rows.map((r) => r.id), ['new', 'mid', 'old']) // current=a 不在 default 里也不该出现 blank-other
})

test('deriveRows: blank 会话是当前会话时保留', () => {
  const list = [mkSession('blank-cur', 600, { blank: true }), mkSession('other', 100)]
  const { sessions, workspaces } = mkSnapshots(list, [{ title: 'default', sessionIds: ['blank-cur', 'other'] }])
  const rows = pureFns.deriveRows(sessions, workspaces)
  assert.deepEqual(rows.map((r) => r.id), ['blank-cur', 'other'])
})

test('deriveRows: updatedAt 相同按 id 升序稳定排序', () => {
  const list = [mkSession('b', 100), mkSession('a', 100), mkSession('c', 100)]
  const { sessions, workspaces } = mkSnapshots(list, [{ title: 'default', sessionIds: ['b', 'a', 'c'] }])
  assert.deepEqual(pureFns.deriveRows(sessions, workspaces).map((r) => r.id), ['a', 'b', 'c'])
})

// ---------------------------------------------------------------------------
// 0.3 搜索合并（deriveSearchRows）
// ---------------------------------------------------------------------------

function searchSetup() {
  const list = [
    mkSession('alpha-report', 400, { displayTitle: 'Quarterly Report' }),
    mkSession('beta', 300, { displayTitle: '周会记录' }),
    mkSession('gamma', 200, { displayTitle: 'random notes' }),
    mkSession('delta', 100, { displayTitle: 'Report draft' }),
  ]
  const workspaces = [
    { title: 'default', sessionIds: ['alpha-report', 'beta'] },
    { title: 'proj-x', sessionIds: ['gamma', 'delta'] },
  ]
  return mkSnapshots(list, workspaces)
}

test('deriveSearchRows: 空查询返回空集', () => {
  const { sessions, workspaces } = searchSetup()
  assert.deepEqual(pureFns.deriveSearchRows(sessions, workspaces, '  ', null, 20), { rows: [], hasMore: false })
})

test('deriveSearchRows: 标题大小写不敏感匹配，按最近更新倒序；default 行不带工作区名', () => {
  const { sessions, workspaces } = searchSetup()
  const { rows } = pureFns.deriveSearchRows(sessions, workspaces, 'report', null, 20)
  assert.deepEqual(rows.map((r) => r.session.id), ['alpha-report', 'delta'])
  assert.equal(rows[0].label, undefined) // default 工作区
  assert.equal(rows[1].label, 'proj-x')
})

test('deriveSearchRows: 工作区名匹配命中其下会话', () => {
  const { sessions, workspaces } = searchSetup()
  const { rows } = pureFns.deriveSearchRows(sessions, workspaces, 'proj', null, 20)
  assert.deepEqual(rows.map((r) => r.session.id), ['gamma', 'delta'])
})

test('deriveSearchRows: 内容命中去重后追加在本地命中之后，摘要取首条内容项', () => {
  const { sessions, workspaces } = searchSetup()
  const content = {
    items: [
      { sessionId: 'gamma', snippet: ' mentions report inside' },
      { sessionId: 'alpha-report', snippet: 'dup should not repeat' },
      { sessionId: 'gamma', snippet: 'second snippet ignored' },
    ],
    hasMore: false,
  }
  const { rows } = pureFns.deriveSearchRows(sessions, workspaces, 'report', content, 20)
  assert.deepEqual(rows.map((r) => r.session.id), ['alpha-report', 'delta', 'gamma'])
  assert.equal(rows[2].snippet, ' mentions report inside')
})

test('deriveSearchRows: 排除子代理/归档/blank 的内容命中', () => {
  const list = [
    mkSession('ok', 400), mkSession('sub', 500, { origin: 'subagent' }),
    mkSession('arc', 600), mkSession('blk', 700, { blank: true }),
  ]
  const { sessions, workspaces } = mkSnapshots(list, [{ title: 'default', sessionIds: list.map((s) => s.id) }])
  workspaces.archivedSessionIds = ['arc']
  const content = { items: list.map((s) => ({ sessionId: s.id, snippet: 'x' })), hasMore: false }
  const { rows } = pureFns.deriveSearchRows(sessions, workspaces, 'x', content, 20)
  assert.deepEqual(rows.map((r) => r.session.id), ['ok']) // 标题 't-x' 全命中但过滤后只剩 ok
})

test('deriveSearchRows: 超出 limit 截断；本地溢出与后端 hasMore 都置提示', () => {
  const { sessions, workspaces } = searchSetup()
  // content=null（防抖窗口内/后端降级）：本地 2 条命中截到 1，同样提示
  const localOnly = pureFns.deriveSearchRows(sessions, workspaces, 'report', null, 1)
  assert.equal(localOnly.rows.length, 1)
  assert.equal(localOnly.hasMore, true)
  // content 参与且未溢出：无提示
  const exact = pureFns.deriveSearchRows(sessions, workspaces, 'report', { items: [], hasMore: false }, 20)
  assert.equal(exact.hasMore, false)
})

test('deriveSearchRows: 后端 hasMore 透传', () => {
  const { sessions, workspaces } = searchSetup()
  const r = pureFns.deriveSearchRows(sessions, workspaces, 'report', { items: [], hasMore: true }, 20)
  assert.equal(r.hasMore, true)
})

// ---------------------------------------------------------------------------
// 0.3 相对时间
// ---------------------------------------------------------------------------

test('relativeTime: 分钟/小时/天/月/年分档', () => {
  const now = Date.now()
  assert.equal(pureFns.relativeTime(now - 10_000, t), '刚刚')
  assert.equal(pureFns.relativeTime(now - 5 * 60_000, t), '5分钟')
  assert.equal(pureFns.relativeTime(now - 3 * 3_600_000, t), '3小时')
  assert.equal(pureFns.relativeTime(now - 2 * 86_400_000, t), '2天')
  assert.equal(pureFns.relativeTime(now - 40 * 86_400_000, t), '1个月')
  assert.equal(pureFns.relativeTime(now - 400 * 86_400_000, t), '1年')
})

// ---------------------------------------------------------------------------
// 0.5 面板筛选与状态判定
// ---------------------------------------------------------------------------

const mkTask = (extra = {}) => ({
  lifecycleStatus: 'active', enabled: true, lastError: null, schedule: { unit: 'minute', interval: 15 },
  nextRunAt: null, runCount: 3, ...extra,
})

test('状态判定：failed/completed/paused/active 四态', () => {
  assert.equal(pureFns.cronStatusKind(mkTask({ lifecycleStatus: 'failed' })), 'failed')
  assert.equal(pureFns.cronStatusKind(mkTask({ lifecycleStatus: 'completed' })), 'completed')
  assert.equal(pureFns.cronStatusKind(mkTask({ lifecycleStatus: 'paused' })), 'paused')
  assert.equal(pureFns.cronStatusKind(mkTask({ enabled: false })), 'paused') // enabled=false 视作暂停
  assert.equal(pureFns.cronStatusKind(mkTask()), 'active')
})

test('筛选归组：lastError 痕迹归失败档；active 与 paused 都算进行中', () => {
  assert.equal(pureFns.cronFilterKind(mkTask()), 'inProgress')
  assert.equal(pureFns.cronFilterKind(mkTask({ lifecycleStatus: 'paused' })), 'inProgress')
  assert.equal(pureFns.cronFilterKind(mkTask({ lastError: 'boom' })), 'failed') // 循环任务失败痕迹
  assert.equal(pureFns.cronFilterKind(mkTask({ lifecycleStatus: 'failed' })), 'failed')
  assert.equal(pureFns.cronFilterKind(mkTask({ lifecycleStatus: 'completed' })), 'completed')
})

test('调度摘要文案：四种节奏（中文）', () => {
  assert.equal(pureFns.cronScheduleText(mkTask(), t), '每 15 分钟')
  assert.equal(pureFns.cronScheduleText(mkTask({ schedule: { unit: 'day', interval: 1, hour: 9, minute: 5 } }), t), '每天 09:05')
  assert.equal(pureFns.cronScheduleText(mkTask({ schedule: { unit: 'week', interval: 1, hour: 9, minute: 0, weekdays: [3, 1] } }), t), '每周一、三 09:00')
  assert.equal(pureFns.cronScheduleText(mkTask({ schedule: { unit: 'month', interval: 1, hour: 9, minute: 0, monthDay: 15 } }), t), '每月 15 日 09:00')
})

test('调度摘要文案：英文词典同样可用', () => {
  const ten = (key) => en[key] ?? key
  assert.equal(pureFns.cronScheduleText(mkTask({ schedule: { unit: 'week', interval: 1, hour: 9, minute: 0, weekdays: [0, 6] } }), ten), 'Weekly on Sat, Sun at 09:00')
})

test('下次运行相对时间：过期/缺失返回 null，其余分档', () => {
  const now = Date.now()
  assert.equal(pureFns.cronFutureRelative(now - 1000, t), null)
  assert.equal(pureFns.cronFutureRelative(null, t), null)
  assert.equal(pureFns.cronFutureRelative(now + 20_000, t), '即将运行') // <30s 舍入为 0 分钟
  assert.equal(pureFns.cronFutureRelative(now + 5 * 60_000, t), '5 分钟后')
  assert.equal(pureFns.cronFutureRelative(now + 3 * 3_600_000, t), '3 小时后')
  assert.equal(pureFns.cronFutureRelative(now + 2 * 86_400_000, t), '2 天后')
})

// ---------------------------------------------------------------------------
// format 工具
// ---------------------------------------------------------------------------

test('format: 命中替换、缺失参数落空串', () => {
  assert.equal(pureFns.format('{n} 分钟', { n: 5 }), '5 分钟')
  assert.equal(pureFns.format('{a}-{b}', { a: 1 }), '1-')
})
