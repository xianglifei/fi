// 0.5 定时任务——调度纯逻辑单元测试。
// 被测对象：src/main/cron.ts 的 computeNextRunAt / normalizeSchedule（编译产物）。
// 运行前先构建：pnpm exec tsup src/main/cron.ts --format cjs --external electron --outDir out/test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const compiled = new URL('../out/test/cron.js', import.meta.url)
if (!existsSync(compiled)) {
  assert.fail('缺少编译产物 out/test/cron.js，先运行: pnpm exec tsup src/main/cron.ts --format cjs --external electron --outDir out/test')
}
const { computeNextRunAt, normalizeSchedule } = createRequire(import.meta.url)(compiled.pathname)

const MINUTE = 60_000
const DAY = 24 * 60 * 60_000
const at = (y, m, d, h, min) => new Date(y, m, d, h, min, 0, 0).getTime()

// ---------------------------------------------------------------------------
// computeNextRunAt — unit: minute（纯算术，与时区无关）
// ---------------------------------------------------------------------------

test('minute: from == anchor 时取 anchor+interval（严格晚于 from，不立即到期）', () => {
  const anchor = 1_000_000
  const s = { unit: 'minute', interval: 15, anchorAt: anchor }
  assert.equal(computeNextRunAt(s, anchor), anchor + 15 * MINUTE)
})

test('minute: from 恰好落在边界上时取下一个边界（不含当前时刻）', () => {
  const anchor = 1_000_000
  const s = { unit: 'minute', interval: 15, anchorAt: anchor }
  assert.equal(computeNextRunAt(s, anchor + 15 * MINUTE), anchor + 30 * MINUTE)
})

test('minute: from 在两个边界之间时取下一个边界', () => {
  const anchor = 1_000_000
  const s = { unit: 'minute', interval: 5, anchorAt: anchor }
  // 12 分钟处 → 下一个是 15 分钟处
  assert.equal(computeNextRunAt(s, anchor + 12 * MINUTE), anchor + 15 * MINUTE)
})

test('minute: from 早于锚点（时钟回拨/编辑后重算）时取锚点本身', () => {
  const anchor = 10_000_000
  const s = { unit: 'minute', interval: 10, anchorAt: anchor }
  assert.equal(computeNextRunAt(s, anchor - 1), anchor)
})

test('minute: interval <= 0 防御为每 1 分钟', () => {
  const anchor = 5_000_000
  assert.equal(computeNextRunAt({ unit: 'minute', interval: 0, anchorAt: anchor }, anchor), anchor + MINUTE)
})

// ---------------------------------------------------------------------------
// computeNextRunAt — unit: day（本地日历 + 固定 24h 步长）
// ---------------------------------------------------------------------------

test('day: 当天时刻未到 → 当天；已过 → 顺延一个间隔', () => {
  const anchor = at(2026, 8, 22, 10, 30) // 2026-09-22 10:30 创建
  const s = { unit: 'day', interval: 1, hour: 9, minute: 0, anchorAt: anchor }
  assert.equal(computeNextRunAt(s, at(2026, 8, 22, 8, 0)), at(2026, 8, 22, 9, 0))
  assert.equal(computeNextRunAt(s, at(2026, 8, 22, 9, 0)), at(2026, 8, 23, 9, 0)) // 恰好 9:00 不算
  assert.equal(computeNextRunAt(s, at(2026, 8, 22, 10, 0)), at(2026, 8, 23, 9, 0))
})

test('day: interval=2 时从锚点日隔天对齐（跳过中间日）', () => {
  const anchor = at(2026, 8, 22, 9, 0)
  const s = { unit: 'day', interval: 2, hour: 9, minute: 0, anchorAt: anchor }
  assert.equal(computeNextRunAt(s, at(2026, 8, 23, 10, 0)), at(2026, 8, 24, 9, 0))
  assert.equal(computeNextRunAt(s, at(2026, 8, 24, 10, 0)), at(2026, 8, 26, 9, 0))
})

test('day: from 超过防御上限（4000 次迭代 ≈ 11 年）返回 null', () => {
  const anchor = at(2026, 0, 1, 9, 0)
  const s = { unit: 'day', interval: 1, hour: 9, minute: 0, anchorAt: anchor }
  assert.equal(computeNextRunAt(s, anchor + 4001 * DAY), null)
})

// ---------------------------------------------------------------------------
// computeNextRunAt — unit: week（锚点日为第一天的 7 天窗口 + 星期过滤）
// ---------------------------------------------------------------------------

/** 最近的一个周一 00:00（本地），作为周锚点。 */
function mondayOffset(extraDays = 0, extraHours = 0) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + extraDays)
  return d.getTime() + extraHours * 60 * 60_000
}

test('week: 周内已过所选星期 → 下周同日同时刻', () => {
  const anchor = mondayOffset() // 周一 00:00
  const s = { unit: 'week', interval: 1, hour: 9, minute: 0, weekdays: [1], anchorAt: anchor }
  const from = anchor + 3 * DAY // 周四
  const expected = new Date(anchor + 7 * DAY)
  assert.equal(
    computeNextRunAt(s, from),
    at(expected.getFullYear(), expected.getMonth(), expected.getDate(), 9, 0),
  )
})

test('week: 当天所选时刻之前 → 当天；恰好到点 → 顺延一周', () => {
  const anchor = mondayOffset()
  const s = { unit: 'week', interval: 1, hour: 9, minute: 0, weekdays: [1], anchorAt: anchor }
  assert.equal(computeNextRunAt(s, anchor + 8 * 60 * 60_000), anchor + 9 * 60 * 60_000)
  assert.equal(computeNextRunAt(s, anchor + 9 * 60 * 60_000), anchor + 7 * DAY + 9 * 60 * 60_000)
})

test('week: 多个星期按时间先后取最近一个', () => {
  const anchor = mondayOffset()
  const s = { unit: 'week', interval: 1, hour: 9, minute: 0, weekdays: [1, 3, 5], anchorAt: anchor }
  const from = anchor + 1 * DAY // 周二 → 下一个是周三
  const expected = new Date(anchor + 2 * DAY)
  assert.equal(
    computeNextRunAt(s, from),
    at(expected.getFullYear(), expected.getMonth(), expected.getDate(), 9, 0),
  )
})

test('week: interval=2 只在偶数窗口生效（隔周）', () => {
  const anchor = mondayOffset()
  const s = { unit: 'week', interval: 2, hour: 9, minute: 0, weekdays: [1], anchorAt: anchor }
  const from = anchor + 8 * DAY // 下周二 → 窗口 0 已过，跳到窗口 2 的周一（+14d）
  const expected = new Date(anchor + 14 * DAY)
  assert.equal(
    computeNextRunAt(s, from),
    at(expected.getFullYear(), expected.getMonth(), expected.getDate(), 9, 0),
  )
})

test('week: weekdays 为空数组时防御为周一', () => {
  const anchor = mondayOffset()
  const s = { unit: 'week', interval: 1, hour: 9, minute: 0, weekdays: [], anchorAt: anchor }
  const from = anchor + 3 * DAY
  const expected = new Date(anchor + 7 * DAY)
  assert.equal(
    computeNextRunAt(s, from),
    at(expected.getFullYear(), expected.getMonth(), expected.getDate(), 9, 0),
  )
})

// ---------------------------------------------------------------------------
// computeNextRunAt — unit: month（monthDay 限 1-28，月份溢出跨年归一）
// ---------------------------------------------------------------------------

test('month: 常规月内推进与跨月', () => {
  const anchor = at(2026, 0, 15, 10, 0) // 2026-01-15 创建
  const s = { unit: 'month', interval: 1, hour: 9, minute: 0, monthDay: 10, anchorAt: anchor }
  assert.equal(computeNextRunAt(s, at(2026, 0, 20, 0, 0)), at(2026, 1, 10, 9, 0)) // → 2 月 10 日
  assert.equal(computeNextRunAt(s, at(2026, 1, 5, 0, 0)), at(2026, 1, 10, 9, 0)) // 当月未到点
  assert.equal(computeNextRunAt(s, at(2026, 1, 20, 0, 0)), at(2026, 2, 10, 9, 0)) // → 3 月 10 日
})

test('month: interval=2 隔月对齐（跳过中间月）', () => {
  const anchor = at(2026, 0, 15, 9, 0)
  const s = { unit: 'month', interval: 2, hour: 9, minute: 0, monthDay: 28, anchorAt: anchor }
  assert.equal(computeNextRunAt(s, at(2026, 1, 1, 0, 0)), at(2026, 2, 28, 9, 0)) // 2 月被跳过
})

test('month: 跨年归一（当月 28 日已过 → 次年 1 月）', () => {
  const anchor = at(2026, 0, 15, 9, 0)
  const s = { unit: 'month', interval: 1, hour: 9, minute: 0, monthDay: 28, anchorAt: anchor }
  assert.equal(computeNextRunAt(s, at(2026, 11, 20, 0, 0)), at(2026, 11, 28, 9, 0)) // 当月 28 日未到
  assert.equal(computeNextRunAt(s, at(2026, 11, 29, 0, 0)), at(2027, 0, 28, 9, 0)) // 已过 → 次年 1 月
})

test('month: 锚点月当天时刻早于 from 时也算当月候选', () => {
  const anchor = at(2026, 5, 15, 23, 0) // 6 月 15 日深夜创建
  const s = { unit: 'month', interval: 1, hour: 0, minute: 0, monthDay: 1, anchorAt: anchor }
  assert.equal(computeNextRunAt(s, at(2026, 5, 16, 0, 0)), at(2026, 6, 1, 0, 0))
})

// ---------------------------------------------------------------------------
// normalizeSchedule — 面板草稿校验与归一化
// ---------------------------------------------------------------------------

test('normalizeSchedule: minute 不需要时刻字段', () => {
  const r = normalizeSchedule({ unit: 'minute', interval: 10 }, 123)
  assert.deepEqual(r, { ok: true, schedule: { unit: 'minute', interval: 10, anchorAt: 123 } })
})

test('normalizeSchedule: 非法 unit 拒绝', () => {
  assert.equal(normalizeSchedule({ unit: 'hour', interval: 1 }, 0).ok, false)
})

test('normalizeSchedule: interval NaN 拒绝；0 / 负数收敛为 1；小数向下取整', () => {
  assert.equal(normalizeSchedule({ unit: 'minute', interval: Number.NaN }, 0).ok, false)
  // 0 与负数被 clampInt 收敛到 1（静默接受，见质量报告）
  assert.equal(normalizeSchedule({ unit: 'minute', interval: 0 }, 0).schedule.interval, 1)
  assert.equal(normalizeSchedule({ unit: 'minute', interval: -5 }, 0).schedule.interval, 1)
  // 小数向下取整
  const frac = normalizeSchedule({ unit: 'minute', interval: 2.9 }, 0)
  assert.equal(frac.schedule.interval, 2)
})

test('normalizeSchedule: day/week/month 必须带 HH:MM 时刻', () => {
  for (const unit of ['day', 'week', 'month']) {
    const missing = normalizeSchedule({ unit, interval: 1 }, 0)
    assert.equal(missing.ok, false, `${unit} 缺 at 应报错`)
  }
  const bad = normalizeSchedule({ unit: 'day', interval: 1, at: '9:5' }, 0) // 分钟须两位
  assert.equal(bad.ok, false)
  const ok = normalizeSchedule({ unit: 'day', interval: 1, at: '9:05' }, 0)
  assert.equal(ok.ok, true)
  assert.equal(ok.schedule.hour, 9)
  assert.equal(ok.schedule.minute, 5)
})

test('normalizeSchedule: 越界时刻静默收敛而非拒绝（记录为质量发现）', () => {
  const late = normalizeSchedule({ unit: 'day', interval: 1, at: '25:99' }, 0)
  assert.equal(late.ok, true)
  assert.equal(late.schedule.hour, 23)
  assert.equal(late.schedule.minute, 59)
})

test('normalizeSchedule: week 空 weekdays 拒绝；越界收敛到 [0,6]（排序由消费端负责）', () => {
  assert.equal(normalizeSchedule({ unit: 'week', interval: 1, at: '09:00', weekdays: [] }, 0).ok, false)
  const r = normalizeSchedule({ unit: 'week', interval: 1, at: '09:00', weekdays: [3, 1, 8] }, 0)
  assert.deepEqual([...r.schedule.weekdays].sort((a, b) => a - b), [1, 3, 6])
})

test('normalizeSchedule: month monthDay 缺省 1、越界收敛到 [1,28]', () => {
  assert.equal(normalizeSchedule({ unit: 'month', interval: 1, at: '09:00' }, 0).schedule.monthDay, 1)
  assert.equal(normalizeSchedule({ unit: 'month', interval: 1, at: '09:00', monthDay: 0 }, 0).schedule.monthDay, 1)
  assert.equal(normalizeSchedule({ unit: 'month', interval: 1, at: '09:00', monthDay: 40 }, 0).schedule.monthDay, 28)
})
