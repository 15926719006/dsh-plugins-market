/**
 * Host 侧契约测试：路由、旁注、单号扫描、平台状态。
 * 每个用例用独立的临时 HOME，互不污染。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 一个进程一个临时 HOME：模块顶层的 DIR 在导入时就固定了，所以每个用例
// 只能清状态文件，不能换 HOME。
const HOME = mkdtempSync(join(tmpdir(), 'workbench-test-'))
process.env.HOME = HOME
const { apply, deriveFromVersion, readRecord } = await import('../index.js')

/** 造一个只够用的 Host ctx；`sessionQuery` 可选。 */
function createCtx(sessionQuery) {
  rmSync(join(HOME, '.dsh', 'workbench'), { recursive: true, force: true })
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

const jsonRequest = (url, body) => new Request(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

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

test('写入一条旁注并读回，非法字段被丢弃', async () => {
  const routes = createCtx()
  const notes = routes.get('/api/workbench/notes')

  const empty = await (await call(notes, new Request('http://localhost/api/workbench/notes'))).json()
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.notes, {})
  assert.match(empty.config.workRoot, /Desktop\/work$/u)

  const saved = await (await call(notes, jsonRequest('http://localhost/api/workbench/notes', {
    sessionId: 'session-abc',
    patch: { outcome: '把发票触发的判定改成后端', next: '等 SRE 给发布窗口', status: 'done', reviveAt: 1700000000000, bogus: 'x' },
  }))).json()
  assert.equal(saved.ok, true)
  assert.equal(saved.note.writtenBy, 'user')
  assert.equal(saved.note.reviveAt, 1700000000000)
  assert.equal('bogus' in saved.note, false)

  const read = await (await call(notes, new Request('http://localhost/api/workbench/notes'))).json()
  assert.equal(read.notes['session-abc'].outcome, '把发票触发的判定改成后端')
})

test('拒绝非法状态值与空 key', async () => {
  const routes = createCtx()
  const notes = routes.get('/api/workbench/notes')

  const bad = await call(notes, jsonRequest('http://localhost/api/workbench/notes', { key: '', patch: {} }))
  assert.equal(bad.status, 400)

  await call(notes, jsonRequest('http://localhost/api/workbench/notes', { key: 'devops:RO-1', patch: { status: 'nonsense' } }))
  const read = await (await call(notes, new Request('http://localhost/api/workbench/notes'))).json()
  assert.equal('status' in read.notes['devops:RO-1'], false)
})

test('配置可以改并读回', async () => {
  const routes = createCtx()
  const config = routes.get('/api/workbench/config')
  const posted = await (await call(config, jsonRequest('http://localhost/api/workbench/config', { workRoot: '/tmp/other' }))).json()
  assert.equal(posted.config.workRoot, '/tmp/other')

  const read = await (await call(config, new Request('http://localhost/api/workbench/config'))).json()
  assert.equal(read.config.workRoot, '/tmp/other')
})

test('只认用户主动提的那一个单号：工具输出里的编号不算', async () => {
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' }, text: '看下 https://devops.ronhan.com/#demand/RO-20260923-028?mode=edit' } },
    { type: 'tool/result', data: { output: '子任务 RO-20260923-028-S04，另见 T-20261026-016 / ON3-66441' } },
    { type: 'assistant/message', data: { text: '顺手提一下 BUG-20260920-001' } },
  ]
  const routes = createCtx({ readSession: async () => ({ events }) })
  const refs = routes.get('/api/workbench/refs')

  const first = await (await call(refs, jsonRequest('http://localhost/api/workbench/refs', { sessions: [{ id: 'session-1', updatedAt: 100 }] }))).json()
  assert.deepEqual(first.refs['session-1'], ['RO-20260923-028'])
  assert.equal(first.scanned, 1)

  const second = await (await call(refs, jsonRequest('http://localhost/api/workbench/refs', { sessions: [{ id: 'session-1', updatedAt: 100 }] }))).json()
  assert.equal(second.scanned, 0, '同一 updatedAt 走缓存')
  assert.deepEqual(second.refs['session-1'], ['RO-20260923-028'])
})

test('注入的上下文（runtime-context / agent-instructions）不算用户说话', async () => {
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' }, text: 'confluence 里面找下，创新应用部最近在干嘛' } },
    { type: 'user/message', data: { source: { kind: 'runtime-context' }, text: 'Current runtime context. RO-20260923-031' } },
    { type: 'user/message', data: { source: { kind: 'agent-instructions' }, text: '<system-reminder>RO-20260923-031</system-reminder>' } },
  ]
  const routes = createCtx({ readSession: async () => ({ events }) })
  const refs = routes.get('/api/workbench/refs')
  const body = await (await call(refs, jsonRequest('http://localhost/api/workbench/refs', { sessions: [{ id: 's', updatedAt: 1 }] }))).json()
  assert.deepEqual(body.refs['s'], [])
})

test('链接优先：1~2 个取第一个，3 个以上算批量检索', async () => {
  const twoLinks = [
    { type: 'user/message', data: { source: { kind: 'user' }, text: 'https://devops.ronhan.com/#demand/RO-20260923-029?mode=edit&from=project-management%2FP-20260908-001 做开发设计，前端复用 https://devops.ronhan.com/#demand/RO-20260923-028?mode=edit 这个分支' } },
  ]
  const batch = [
    { type: 'user/message', data: { source: { kind: 'user' }, text: '拉一下这周的单：https://devops.ronhan.com/#demand/RO-20261021-010 https://devops.ronhan.com/#demand/RO-20261008-004 https://devops.ronhan.com/#demand/RO-20261019-012' } },
  ]
  const routes = createCtx({ readSession: async (id) => ({ events: id === 'two' ? twoLinks : batch }) })
  const refs = routes.get('/api/workbench/refs')
  const body = await (await call(refs, jsonRequest('http://localhost/api/workbench/refs', { sessions: [{ id: 'two', updatedAt: 1 }, { id: 'batch', updatedAt: 1 }] }))).json()
  assert.deepEqual(body.refs['two'], ['RO-20260923-029'])
  assert.deepEqual(body.refs['batch'], [], '一次贴三条链接属于检索')
})

test('没有链接时，一条消息只提一个编号才算', async () => {
  const single = [{ type: 'user/message', data: { source: { kind: 'user' }, text: 'RO-20261026-019 这个需求，给我创建子任务' } }]
  const many = [{ type: 'user/message', data: { source: { kind: 'user' }, text: '整理下我这周的：RO-20261021-010 RO-20261008-004' } }]
  const routes = createCtx({ readSession: async (id) => ({ events: id === 'one' ? single : many }) })
  const refs = routes.get('/api/workbench/refs')
  const body = await (await call(refs, jsonRequest('http://localhost/api/workbench/refs', { sessions: [{ id: 'one', updatedAt: 1 }, { id: 'many', updatedAt: 1 }] }))).json()
  assert.deepEqual(body.refs['one'], ['RO-20261026-019'])
  assert.deepEqual(body.refs['many'], [])
})

test('专项（P-）不作为任务，子任务归到父需求', async () => {
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' }, text: 'https://devops.ronhan.com/#project-management/P-20260908-001 看下这个大项目' } },
    { type: 'user/message', data: { source: { kind: 'user' }, text: 'RO-20260923-028-S04 这个子任务继续' } },
  ]
  const routes = createCtx({ readSession: async () => ({ events }) })
  const refs = routes.get('/api/workbench/refs')
  const body = await (await call(refs, jsonRequest('http://localhost/api/workbench/refs', { sessions: [{ id: 'p', updatedAt: 1 }] }))).json()
  assert.deepEqual(body.refs['p'], ['RO-20260923-028'], '专项跳过，接着命中父需求')
})

test('没有 sessionQuery 时如实报告，不假装扫过', async () => {
  const routes = createCtx(undefined)
  const refs = routes.get('/api/workbench/refs')
  const body = await (await call(refs, jsonRequest('http://localhost/api/workbench/refs', { sessions: [{ id: 's', updatedAt: 1 }] }))).json()
  assert.equal(body.hasScanner, false)
  assert.deepEqual(body.refs, {})
})

test('状态直接读平台的 status 字段', () => {
  const demand = readRecord('demand', {
    order: { title: '收银台V1埋点下线', version: 'v2.1.11_2-stable' },
    demand: { status: 'COMPLETED' },
  })
  assert.equal(demand.statusLabel, '已完成')
  assert.equal(demand.group, 'done')
  assert.equal(demand.version, 'v2.1.11_2-stable')

  assert.equal(readRecord('demand', { order: {}, demand: { status: 'DEVELOPING' } }).statusLabel, '开发中')
  assert.equal(readRecord('demand', { order: {}, demand: { status: 'PENDING_PRODUCT_ACCEPTANCE' } }).statusLabel, '待产品验收')
  assert.equal(readRecord('task', { name: 'x', status: 'COMPLETED' }).group, 'done')
  assert.equal(readRecord('task', { name: 'x', status: 'CANCELLED' }).group, 'cancelled')
  assert.equal(readRecord('defect', { name: 'y', status: 'CLOSED' }).group, 'done')
  assert.equal(readRecord('defect', { name: 'y', status: 'SUSPENDED' }).group, 'open')
  assert.equal(readRecord('demand', null).statusLabel, '')
})

test('没有 devops 凭据时记录留空但链接照给', async () => {
  const routes = createCtx()
  const records = routes.get('/api/workbench/records')
  const body = await (await call(records, jsonRequest('http://localhost/api/workbench/records', {
    refs: ['RO-20260923-031', 'T-20261026-016', 'BUG-20260920-001', 'ON3-66441'],
  }))).json()
  assert.equal(body.ok, true)
  assert.equal(body.records['RO-20260923-031'].statusLabel, '')
  assert.equal(body.records['RO-20260923-031'].group, 'unknown')
  assert.match(body.records['RO-20260923-031'].url, /#demand\/RO-20260923-031$/u)
  assert.match(body.records['T-20261026-016'].url, /\/task\/T-20261026-016$/u)
  assert.match(body.records['BUG-20260920-001'].url, /\/defect\/BUG-20260920-001$/u)
  assert.equal(body.records['ON3-66441'].url, null)
})

test('版本单日期决定上线日期', () => {
  const now = Date.parse('2026-11-20T12:00:00+08:00')
  const past = deriveFromVersion('2026-11-09 常规版本', now)
  assert.equal(past.released, true)
  assert.equal(past.at, Date.parse('2026-11-09T00:00:00+08:00'))

  const future = deriveFromVersion('2026-11-23 常规版本', now)
  assert.equal(future.released, false)

  assert.equal(deriveFromVersion('PaymentLink 补齐 Stripe Radar', now).at, null)
})
