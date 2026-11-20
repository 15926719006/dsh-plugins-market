/**
 * Host 侧契约测试：路由注册、旁注写入与读回、配置持久化。
 * 用临时 HOME 隔离，不碰真实 `~/.dsh/workbench/`。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const HOME = mkdtempSync(join(tmpdir(), 'workbench-test-'))
process.env.HOME = HOME

const { apply, derivePlatformState, deriveFromVersion } = await import('../index.js')

/** 造一个只够用的 Host ctx；`sessionQuery` 可选。 */
function createCtx(sessionQuery) {
  const routes = new Map()
  const ctx = {
    get(name) {
      return name === 'sessionQuery' ? sessionQuery : undefined
    },
    effect(callback) {
      return callback()
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    logger: { warn() {} },
  }
  apply(ctx)
  return routes
}

const call = (route, request) => route.fetch(request)

test('注册五条路由', () => {
  const routes = createCtx()
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/workbench/config',
    '/api/workbench/log',
    '/api/workbench/notes',
    '/api/workbench/records',
    '/api/workbench/refs',
  ])
})

test('没有 devops 凭据时记录留空但链接照给', async () => {
  const routes = createCtx()
  const records = routes.get('/api/workbench/records')
  const body = await (await call(records, new Request('http://localhost/api/workbench/records', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refs: ['RO-20260923-031', 'T-20261026-016', 'BUG-20260920-001', 'ON3-66441'] }),
  }))).json()
  assert.equal(body.ok, true)
  assert.equal(body.records['RO-20260923-031'].title, '')
  assert.equal(body.records['RO-20260923-031'].state, 'unknown')
  assert.match(body.records['RO-20260923-031'].url, /#demand\/RO-20260923-031$/u)
  assert.match(body.records['T-20261026-016'].url, /\/task\/T-20261026-016$/u)
  assert.match(body.records['BUG-20260920-001'].url, /\/defect\/BUG-20260920-001$/u)
  assert.equal(body.records['ON3-66441'].url, null, 'Jira 的 issue 没有 devops 路由')
})

test('写入一条旁注并读回', async () => {
  const routes = createCtx()
  const notes = routes.get('/api/workbench/notes')

  const empty = await (await call(notes, new Request('http://localhost/api/workbench/notes'))).json()
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.notes, {})
  assert.match(empty.config.workRoot, /Desktop\/work$/u)

  const saved = await (await call(notes, new Request('http://localhost/api/workbench/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'session-abc',
      patch: { outcome: '把发票触发的判定改成后端', next: '等 SRE 给发布窗口', status: 'done', refs: [{ kind: 'demand', ref: 'RO-20260923-028' }], bogus: 'x' },
    }),
  }))).json()
  assert.equal(saved.ok, true)
  assert.equal(saved.note.writtenBy, 'user')
  assert.equal('bogus' in saved.note, false)

  const read = await (await call(notes, new Request('http://localhost/api/workbench/notes'))).json()
  assert.equal(read.notes['session-abc'].outcome, '把发票触发的判定改成后端')
  assert.equal(read.notes['session-abc'].refs[0].ref, 'RO-20260923-028')
})

test('拒绝非法状态值与空 sessionId', async () => {
  const routes = createCtx()
  const notes = routes.get('/api/workbench/notes')

  const bad = await call(notes, new Request('http://localhost/api/workbench/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: '', patch: {} }),
  }))
  assert.equal(bad.status, 400)

  await call(notes, new Request('http://localhost/api/workbench/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-x', patch: { status: 'nonsense' } }),
  }))
  const read = await (await call(notes, new Request('http://localhost/api/workbench/notes'))).json()
  assert.equal('status' in read.notes['session-x'], false)
})

test('配置可以改并读回', async () => {
  const routes = createCtx()
  const config = routes.get('/api/workbench/config')
  const posted = await (await call(config, new Request('http://localhost/api/workbench/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workRoot: '/tmp/other' }),
  }))).json()
  assert.equal(posted.config.workRoot, '/tmp/other')

  const read = await (await call(config, new Request('http://localhost/api/workbench/config'))).json()
  assert.equal(read.config.workRoot, '/tmp/other')
})

test('只认用户在谈的那一个单号：工具输出里的编号不算', async () => {
  const events = [
    { type: 'user/message', data: { text: '看下 https://devops.ronhan.com/#demand/RO-20260923-028?mode=edit', source: { kind: 'user' } } },
    { type: 'tool/result', data: { output: '子任务 RO-20260923-028-S04，另见 T-20261026-016 / P-20260908-001 / ON3-66441' } },
    { type: 'assistant/message', data: { text: '顺手提一下 BUG-20260920-001' } },
  ]
  const routes = createCtx({ readSession: async () => ({ events }) })
  const refs = routes.get('/api/workbench/refs')
  const post = (body) => call(refs, new Request('http://localhost/api/workbench/refs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))

  const first = await (await post({ sessions: [{ id: 'session-1', updatedAt: 100 }] })).json()
  assert.deepEqual(first.refs['session-1'], ['RO-20260923-028'])
  assert.equal(first.scanned, 1)

  const second = await (await post({ sessions: [{ id: 'session-1', updatedAt: 100 }] })).json()
  assert.equal(second.scanned, 0, '同一 updatedAt 走缓存')
  assert.deepEqual(second.refs['session-1'], ['RO-20260923-028'])
})

test('注入的上下文（runtime-context / skill-catalog 等）不算用户说话', async () => {
  const events = [
    { type: 'user/message', data: { text: 'confluence 里面找下，创新应用部最近在干嘛', source: { kind: 'user' } } },
    { type: 'user/message', data: { text: 'Current runtime context. RO-20260923-031', source: { kind: 'runtime-context' } } },
    { type: 'user/message', data: { text: '<system-reminder>RO-20260923-031</system-reminder>', source: { kind: 'agent-instructions' } } },
  ]
  const routes = createCtx({ readSession: async () => ({ events }) })
  const refs = routes.get('/api/workbench/refs')
  const body = await (await call(refs, new Request('http://localhost/api/workbench/refs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessions: [{ id: 'session-injected', updatedAt: 1 }] }),
  }))).json()
  assert.deepEqual(body.refs['session-injected'], [], '注入上下文里的单号不构成本会话的任务')
})

test('批量消息不命中；后面单独提一个才命中；助手提到的不算', async () => {
  const pasted = [
    { type: 'user/message', data: { text: '拉一下这周的单：RO-20261021-010 RO-20261008-004 ON3-59822', source: { kind: 'user' } } },
    { type: 'user/message', data: { text: '另外 RO-20261021-010 这个今天得收尾', source: { kind: 'user' } } },
  ]
  const assistantOnly = [
    { type: 'user/message', data: { text: '帮我把这个需求收个尾', source: { kind: 'user' } } },
    { type: 'assistant/message', data: { text: '对应 BO 需求 RO-20260917-099-S04' } },
  ]
  const routes = createCtx({
    readSession: async (id) => ({ events: id === 'session-paste' ? pasted : assistantOnly }),
  })
  const refs = routes.get('/api/workbench/refs')
  const body = await (await call(refs, new Request('http://localhost/api/workbench/refs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessions: [
      { id: 'session-paste', updatedAt: 1 },
      { id: 'session-assistant', updatedAt: 1 },
    ] }),
  }))).json()

  assert.deepEqual(body.refs['session-paste'], ['RO-20261021-010'], '批量那条不算，单独提的那条算')
  assert.deepEqual(body.refs['session-assistant'], [], '助手说过的单号不算用户的任务')
})

test('没有 sessionQuery 时如实报告，不假装扫过', async () => {
  const routes = createCtx(undefined)
  const refs = routes.get('/api/workbench/refs')
  const response = await call(refs, new Request('http://localhost/api/workbench/refs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessions: [{ id: 'session-1', updatedAt: 1 }] }),
  }))
  const body = await response.json()
  assert.equal(body.hasScanner, false)
  assert.deepEqual(body.refs, {})
})

test('链接优先：一条消息里链接 1~2 个取第一个，3 个以上算批量', async () => {
  const twoLinks = [
    { type: 'user/message', data: { source: { kind: 'user' }, text: 'https://devops.ronhan.com/#demand/RO-20260923-029?mode=edit&from=project-management%2FP-20260908-001 做开发设计，前端复用 https://devops.ronhan.com/#demand/RO-20260923-028?mode=edit 这个分支' } },
  ]
  const batch = [
    { type: 'user/message', data: { source: { kind: 'user' }, text: '拉一下这周的单：https://devops.ronhan.com/#demand/RO-20261021-010 https://devops.ronhan.com/#demand/RO-20261008-004 https://devops.ronhan.com/#demand/RO-20261019-012' } },
  ]
  const routes = createCtx({ readSession: async (id) => ({ events: id === 'two' ? twoLinks : batch }) })
  const refs = routes.get('/api/workbench/refs')
  const body = await (await call(refs, new Request('http://localhost/api/workbench/refs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessions: [{ id: 'two', updatedAt: 1 }, { id: 'batch', updatedAt: 1 }] }),
  }))).json()
  assert.deepEqual(body.refs['two'], ['RO-20260923-029'])
  assert.deepEqual(body.refs['batch'], [], '一次贴三条链接属于检索，不算跟进')
})

test('专项（P-）不作为任务', async () => {
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' }, text: 'https://devops.ronhan.com/#project-management/P-20260908-001 看下这个大项目，参与的前端有哪些' } },
  ]
  const routes = createCtx({ readSession: async () => ({ events }) })
  const refs = routes.get('/api/workbench/refs')
  const body = await (await call(refs, new Request('http://localhost/api/workbench/refs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessions: [{ id: 'p', updatedAt: 1 }] }),
  }))).json()
  assert.deepEqual(body.refs['p'], [])
})

test('环境进度推出平台状态：取推进最远的那个', () => {
  const envs = (list) => list.map(([env, status, date]) => ({ env, status, completedAt: date ?? null }))

  assert.equal(derivePlatformState([]).state, 'unknown')
  assert.equal(derivePlatformState(envs([['BETA', 'EDITING'], ['TEST', 'EDITING'], ['PROD', 'EDITING'], ['SANDBOX', 'COMPLETED']])).state, 'dev', 'SANDBOX 不算进度')

  const beta = derivePlatformState(envs([['BETA', 'COMPLETED', '2026-11-17T10:00:00+08:00'], ['TEST', 'EDITING'], ['PROD', 'EDITING']]))
  assert.equal(beta.state, 'beta')
  assert.equal(beta.onlineAt, null)

  const uat = derivePlatformState(envs([['BETA', 'COMPLETED'], ['TEST', 'EDITING'], ['UAT', 'COMPLETED', '2026-11-18T10:00:00+08:00'], ['PROD', 'EDITING']]))
  assert.equal(uat.state, 'uat', '不看 TEST，取 UAT 这个更远的')

  const online = derivePlatformState(envs([['BETA', 'COMPLETED'], ['PROD', 'COMPLETED', '2026-11-19T09:00:00+08:00']]))
  assert.equal(online.state, 'online')
  assert.equal(online.onlineAt, Date.parse('2026-11-19T09:00:00+08:00'))
  assert.equal(online.envs.length, 2, 'SANDBOX 被过滤掉')
})

test('版本单日期决定是否上线', () => {
  const now = Date.parse('2026-11-20T12:00:00+08:00')
  const past = deriveFromVersion('2026-11-09 常规版本', now)
  assert.equal(past.released, true)
  assert.equal(past.at, Date.parse('2026-11-09T00:00:00+08:00'))

  const future = deriveFromVersion('2026-11-23 常规版本', now)
  assert.equal(future.released, false)
  assert.ok(future.at > now)

  assert.equal(deriveFromVersion('PaymentLink 补齐 Stripe Radar', now).at, null, '没有日期的版本单不判上线')
})
