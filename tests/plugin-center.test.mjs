// 0.7 插件中心——清单纯逻辑单元测试。
// 被测对象：src/main/plugin-center.ts 的 collectInstalled / normalizeRepoUrl（编译产物）。
// 运行前先构建：pnpm exec tsup src/main/plugin-center.ts --format cjs --external electron --outDir out/test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const compiled = new URL('../out/test/plugin-center.js', import.meta.url)
if (!existsSync(compiled)) {
  assert.fail('缺少编译产物 out/test/plugin-center.js，先运行: pnpm exec tsup src/main/plugin-center.ts --format cjs --external electron --outDir out/test')
}
const { collectInstalled, normalizeRepoUrl, isRemovablePluginName } = createRequire(import.meta.url)(compiled.pathname)

/** node_modules 读桩：表驱动 name → package.json 内容；未列出 = 读取失败（损坏/缺失）。 */
const mkReadPkg = (table = {}) => (name) => table[name] ?? null

// ---------------------------------------------------------------------------
// collectInstalled —「已安装」边界的口径
// ---------------------------------------------------------------------------

test('内置 fi-sidebar 过滤不展示（随壳自动 link，非用户安装）', () => {
  const rows = collectInstalled(
    { 'fi-sidebar': 'link:/somewhere/fi/dsh-plugin', 'dsh-whale-widget': '^0.3.10' },
    mkReadPkg({ 'dsh-whale-widget': { version: '0.3.10', description: '鲸鱼' } }),
  )
  assert.deepEqual(rows.map((r) => r.name), ['dsh-whale-widget'])
})

test('版本取 node_modules 的 package.json；读不到回退为依赖 spec（link:/github: 如实展示）', () => {
  const rows = collectInstalled(
    { 'dsh-peak-hours': 'link:/Users/x/fx-dsh/dsh-peak-hours', 'dsh-whale-widget': 'github:MeteorNOX/DeepSeek-Balance-Whale-Widget' },
    mkReadPkg({ 'dsh-peak-hours': { version: '0.2.0', description: '峰时' } }),
  )
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
  assert.equal(byName['dsh-peak-hours'].version, '0.2.0')
  assert.equal(byName['dsh-whale-widget'].version, 'github:MeteorNOX/DeepSeek-Balance-Whale-Widget')
  assert.equal(byName['dsh-whale-widget'].description, '')
  assert.equal(byName['dsh-whale-widget'].repo, null)
})

test('描述与仓库地址透传；输出按包名排序', () => {
  const rows = collectInstalled(
    { 'b-plugin': '1.0.0', 'a-plugin': '1.0.0' },
    mkReadPkg({
      'a-plugin': { version: '1.0.0', description: 'A 的描述', repository: 'git+https://github.com/x/a.git' },
      'b-plugin': { version: '2.0.0', description: '', repository: { url: 'https://github.com/x/b' } },
    }),
  )
  assert.deepEqual(rows.map((r) => r.name), ['a-plugin', 'b-plugin'])
  assert.equal(rows[0].description, 'A 的描述')
  assert.equal(rows[0].repo, 'https://github.com/x/a')
  assert.equal(rows[1].repo, 'https://github.com/x/b')
})

test('空依赖表 → 空清单（未初始化 profile 不算装过任何东西）', () => {
  assert.deepEqual(collectInstalled({}, mkReadPkg()), [])
})

// ---------------------------------------------------------------------------
// normalizeRepoUrl — 仓库地址归一化
// ---------------------------------------------------------------------------

test('normalizeRepoUrl：git+ 前缀与 .git 后缀剥掉，https 才外显', () => {
  assert.equal(normalizeRepoUrl('git+https://github.com/o/r.git'), 'https://github.com/o/r')
  assert.equal(normalizeRepoUrl('https://github.com/o/r'), 'https://github.com/o/r')
  assert.equal(normalizeRepoUrl('https://example.com/o/r.git'), 'https://example.com/o/r')
  assert.equal(normalizeRepoUrl('git@github.com:o/r.git'), null, 'ssh 地址不外显')
  assert.equal(normalizeRepoUrl(''), null)
  assert.equal(normalizeRepoUrl(null), null)
  assert.equal(normalizeRepoUrl(undefined), null)
})

test('normalizeRepoUrl：repository 对象形态取 url 字段', () => {
  assert.equal(normalizeRepoUrl({ type: 'git', url: 'git+https://github.com/o/r.git' }), 'https://github.com/o/r')
  assert.equal(normalizeRepoUrl({ url: 'not-a-url' }), null)
  assert.equal(normalizeRepoUrl({}), null)
})

// ---------------------------------------------------------------------------
// isRemovablePluginName — 卸载目标的门禁
// ---------------------------------------------------------------------------

test('isRemovablePluginName：合法包名放行（含 @scope/、数字前缀）', () => {
  assert.equal(isRemovablePluginName('dsh-whale-widget'), true)
  assert.equal(isRemovablePluginName('@scope/dsh-plugin'), true)
  assert.equal(isRemovablePluginName('dsh-plugin-2'), true)
})

test('isRemovablePluginName：内置 fi-sidebar 拒绝（卸掉等于拆 fi 侧栏）', () => {
  assert.equal(isRemovablePluginName('fi-sidebar'), false)
})

test('isRemovablePluginName：非串/空串/带空白与控制字符的输入拒绝', () => {
  for (const bad of [null, undefined, 42, {}, '', '   ', 'a b', 'x;y', 'a\nb', 'link:/etc', 'github:o/r']) {
    assert.equal(isRemovablePluginName(bad), false, JSON.stringify(bad))
  }
})
