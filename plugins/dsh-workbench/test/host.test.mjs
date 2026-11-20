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

const { apply } = await import('../host.js')

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

test('注册四条路由', () => {
  const routes = createCtx()
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/workbench/config',
    '/api/workbench/log',
    '/api/workbench/notes',
    '/api/workbench/refs',
  ])
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
    { type: 'user/message', data: { text: '看下 https://devops.ronhan.com/#demand/RO-20260923-028?mode=edit' } },
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

test('用户粘了一整段列表时取第一个；用户没提才看助手；子任务归到父需求', async () => {
  const pasted = [
    { type: 'user/message', data: { text: '这几个一起看：RO-20261021-010 RO-20261008-004 ON3-59822' } },
  ]
  const assistantOnly = [
    { type: 'user/message', data: { text: '帮我把这个需求收个尾' } },
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

  assert.deepEqual(body.refs['session-paste'], ['RO-20261021-010'])
  assert.deepEqual(body.refs['session-assistant'], ['RO-20260917-099'])
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
