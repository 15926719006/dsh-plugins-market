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

const { apply } = await import('../index.js')

/** 造一个只够用的 Host ctx。 */
function createCtx() {
  const routes = new Map()
  const ctx = {
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

test('注册三条路由', () => {
  const routes = createCtx()
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/workbench/config',
    '/api/workbench/log',
    '/api/workbench/notes',
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
