// 发版约定一致性检查（AGENTS.md 规则落地验证）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

test('package.json 版本与 CHANGELOG 最新定版一致', () => {
  const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])
  assert.ok(versions.length > 0, 'CHANGELOG 有版本条目')
  assert.equal(pkg.version, versions[0], `pkg=${pkg.version} changelog=${versions[0]}`)
})

test('CHANGELOG 每个版本都有对比链接，Unreleased 指向最新版', () => {
  const headers = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])
  const links = [...changelog.matchAll(/^\[(Unreleased|\d+\.\d+\.\d+)\]:\s*(\S+)/gm)]
  const linked = new Map(links.map((m) => [m[1], m[2]]))
  assert.ok(linked.has('Unreleased'), 'Unreleased 链接存在')
  assert.match(linked.get('Unreleased'), new RegExp(`compare/v${pkg.version}\\.\\.\\.HEAD`))
  for (const v of headers) {
    assert.ok(linked.has(v), `版本 ${v} 有对比链接`)
  }
})

test('CHANGELOG 覆盖 0.1.0 → 当前版本的连续版本线（无跳档）', () => {
  const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])
  // 已知历史基线随发版自然向上生长：pkg.version 打头（与最新定版重复时去重）。
  const historical = ['0.5.1', '0.5.0', '0.4.0', '0.3.0', '0.2.0', '0.1.1', '0.1.0']
  const expected = [pkg.version, ...historical].filter((v, i, arr) => arr.indexOf(v) === i)
  assert.deepEqual(versions, expected)
})

test('README 记录了壳的对外环境变量契约（0.1）与已知限制', () => {
  for (const token of ['FI_DSH_BIN', 'FI_DSH_URL', 'URL_LINE_RE', '已知限制']) {
    assert.ok(readme.includes(token), `README 提及 ${token}`)
  }
})

test('AGENTS.md 发版规则文件在位', () => {
  const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8')
  assert.match(agents, /CHANGELOG\.md/)
})
