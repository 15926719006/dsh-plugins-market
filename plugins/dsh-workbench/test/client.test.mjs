/**
 * Client 侧逻辑测试：用假的 React 与假的内核快照跑通
 * 「快照 + 旁注 → 行」和「行 → 周报草稿」，并确认两个座位都注册了。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

/** 只够用的 React 替身：hooks 是纯函数，effect 立即执行。 */
const react = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children } }
  },
  useState(initial) {
    return [initial, () => {}]
  },
  useEffect(effect) {
    effect()
  },
  useCallback(fn) {
    return fn
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    return getSnapshot()
  },
}

/** 把 client.js 装进一个假的 ModuleLoader；模块体只执行一次，结果缓存。 */
let cachedModule
async function loadModule() {
  if (cachedModule !== undefined) return cachedModule
  let mod
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        mod = factory((name) => {
          if (name === 'react') return react
          throw new Error(`unexpected require: ${name}`)
        })
      },
    },
  }
  globalThis.__workbenchTest = true
  await import('../client.js')
  cachedModule = mod
  return mod
}

/** 假 Host/内核：一条 work 会话、一条私人会话、一条子智能体会话、一条草稿。 */
function createCtx({ notes = {}, workRoot = '/Users/me/Desktop/work' } = {}) {
  const byId = {
    'session-work': {
      sessionId: 'session-work',
      cwd: '/Users/me/Desktop/work',
      displayTitle: 'RO-20260923-028 发票触发判定',
      updatedAt: Date.now(),
      running: false,
      blank: false,
    },
    'session-sub': {
      sessionId: 'session-sub',
      cwd: '/Users/me/Desktop/work/sub',
      displayTitle: '改支付重试',
      updatedAt: Date.now(),
      running: true,
      blank: false,
    },
    'session-private': {
      sessionId: 'session-private',
      cwd: '/Users/me/Desktop/GAME CREATER',
      displayTitle: '伤害数值',
      updatedAt: Date.now(),
      blank: false,
    },
    'session-child': {
      sessionId: 'session-child',
      cwd: '/Users/me/Desktop/work',
      displayTitle: '子智能体',
      updatedAt: Date.now(),
      origin: 'subagent',
      blank: false,
    },
    'session-draft': {
      sessionId: 'session-draft',
      cwd: '/Users/me/Desktop/work',
      displayTitle: '',
      updatedAt: Date.now(),
      blank: true,
    },
  }

  const registered = new Map()
  const ctx = {
    effect(callback) {
      return callback()
    },
    setTimeout(callback) {
      callback()
      return () => {}
    },
    get(name) {
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId }) } }
      if (name === 'workspaces') return { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } }
      if (name === 'uiWorkspace') return { openSession() {} }
      return undefined
    },
    slots: {
      inject(name, callback) {
        callback()
      },
      register(spec, Component) {
        registered.set(spec.name, { spec, Component })
        return () => {}
      },
    },
  }

  globalThis.fetch = async () => ({
    json: async () => ({ ok: true, notes, config: { workRoot } }),
  })

  return { ctx, registered }
}

test('注册「左侧入口」与「整页」两个座位', async () => {
  const mod = await loadModule()
  const { ctx, registered } = createCtx()
  mod.apply(ctx)
  assert.deepEqual([...registered.keys()].sort(), ['main', 'sidebar.panellist'])
  assert.equal(registered.get('sidebar.panellist').spec.id, 'workbench')
  assert.equal(registered.get('main').spec.key, 'workbench')
  assert.equal(registered.get('sidebar.panellist').spec.label, '需求账本')
})

/** 造一条会话。 */
const session = (id, refs, updatedAt = 1000, extra = {}) => ({
  id,
  title: `会话 ${id}`,
  project: 'work',
  updatedAt,
  running: false,
  refs,
  ...extra,
})

test('同一个单号出现在多个会话里，只算一个任务', async () => {
  const mod = await loadModule()
  const { ctx } = createCtx()
  const api = mod.apply(ctx)
  const { tasks, unlinked } = api.groupTasks([
    session('a', ['RO-20260923-028'], 3000),
    session('b', ['RO-20260923-028'], 1000),
    session('c', ['T-20261026-016'], 2000),
    session('d', [], 1500),
  ], {})

  assert.equal(tasks.length, 2)
  const invoice = tasks.find((task) => task.ref === 'RO-20260923-028')
  assert.equal(invoice.key, 'devops:RO-20260923-028')
  assert.deepEqual(invoice.sessions.map((item) => item.id).sort(), ['a', 'b'])
  assert.equal(invoice.sessions[0].id, 'a') // 最近的排前面
  assert.equal(invoice.updatedAt, 3000)
  assert.equal(invoice.status, 'open')

  assert.deepEqual(unlinked.map((item) => item.key), ['session:d'])
})

test('任务结论写在任务上，不看成员会话', async () => {
  const mod = await loadModule()
  const { ctx } = createCtx()
  const api = mod.apply(ctx)
  const notes = {
    'devops:RO-20260923-028': { outcome: '判定改到后端，已上线', next: '观察一周', updatedAt: 5000 },
  }
  const { tasks } = api.groupTasks([
    session('a', ['RO-20260923-028'], 3000),
    session('b', ['RO-20260923-028'], 1000),
  ], notes)

  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].status, 'done')
  assert.equal(tasks[0].outcome, '判定改到后端，已上线')
  assert.equal(tasks[0].doneAt, 5000)
})

test('一条会话提到两个单号，就同时进两个任务', async () => {
  const mod = await loadModule()
  const { ctx } = createCtx()
  const api = mod.apply(ctx)
  const { tasks } = api.groupTasks([
    session('a', ['RO-20260923-028', 'P-20260908-001'], 2000),
  ], {})
  assert.deepEqual(tasks.map((task) => task.ref).sort(), ['P-20260908-001', 'RO-20260923-028'])
})

test('单号识别与周窗口', async () => {
  const mod = await loadModule()
  const { ctx } = createCtx()
  const api = mod.apply(ctx)
  assert.equal(api.refOf('见 #demand/RO-20260923-028'), 'RO-20260923-028')
  assert.equal(api.refOf('RO-20260923-028-S04 子任务'), 'RO-20260923-028')
  assert.equal(api.refOf('ON3-123 太短不算'), null)
  assert.equal(api.refOf('顺手改了插件'), null)

  const { start, end } = api.weekRange(new Date(2026, 10, 18, 15, 0, 0))
  const startDate = new Date(start)
  assert.equal(startDate.getDay(), 1)
  assert.equal(startDate.getHours(), 0)
  assert.equal(end - start, 7 * 24 * 60 * 60 * 1000)
})

test('休眠：没有下一步 7 天、写了下一步 21 天', async () => {
  const mod = await loadModule()
  const { ctx } = createCtx()
  const api = mod.apply(ctx)
  const now = 1000 * 60 * 60 * 24 * 100
  const day = 86400000
  const mk = (id, ago) => session(id, ['RO-20260923-028'], now - ago * day)

  const plain = api.groupTasks([mk('a', 8)], {}, now)
  assert.equal(plain.tasks[0].dormant, true, '没写下一步，8 天算休眠')
  assert.equal(plain.tasks[0].windowDays, 7)

  const waiting = api.groupTasks([mk('b', 8)], { 'devops:RO-20260923-028': { next: '等发布窗口' } }, now)
  assert.equal(waiting.tasks[0].dormant, false, '写了下一步，8 天还不算休眠')
  assert.equal(waiting.tasks[0].windowDays, 21)

  const waitingLong = api.groupTasks([mk('c', 25)], { 'devops:RO-20260923-028': { next: '等发布窗口' } }, now)
  assert.equal(waitingLong.tasks[0].dormant, true, '写了下一步，25 天算休眠')
})

test('重新关注（reviveAt）把休眠任务拉回活跃', async () => {
  const mod = await loadModule()
  const { ctx } = createCtx()
  const api = mod.apply(ctx)
  const now = 1000 * 60 * 60 * 24 * 100
  const day = 86400000
  const { tasks } = api.groupTasks([session('a', ['RO-20260923-028'], now - 30 * day)], {
    'devops:RO-20260923-028': { reviveAt: now - 1000 },
  }, now)
  assert.equal(tasks[0].dormant, false)
})

test('收尾的任务不算休眠', async () => {
  const mod = await loadModule()
  const { ctx } = createCtx()
  const api = mod.apply(ctx)
  const now = 1000 * 60 * 60 * 24 * 100
  const day = 86400000
  const { tasks } = api.groupTasks([session('a', ['RO-20260923-028'], now - 30 * day)], {
    'devops:RO-20260923-028': { status: 'done', outcome: '已上线' },
  }, now)
  assert.equal(tasks[0].dormant, false)
})

test('任务聚合投入：会话数、我的消息数、跨度、花费', async () => {
  const mod = await loadModule()
  const { ctx } = createCtx()
  const api = mod.apply(ctx)
  const day = 86400000
  const base = 1000 * 60 * 60 * 24 * 100

  const { tasks } = api.groupTasks([
    { id: 'a', title: 'A', project: 'work', updatedAt: base, running: false, refs: ['RO-20260923-028'], userMessages: 12, firstAt: base - 3 * day, lastAt: base, cost: 1.5 },
    { id: 'b', title: 'B', project: 'work', updatedAt: base - 5 * day, running: false, refs: ['RO-20260923-028'], userMessages: 8, firstAt: base - 5 * day, lastAt: base - 5 * day, cost: 0.5 },
  ], {}, base)

  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].messages, 20, '两个会话的消息数相加')
  assert.equal(tasks[0].cost, 2, '费用相加')
  assert.equal(tasks[0].spanDays, 5, '首末跨度取最早的开始和最晚的结束')
})

