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
  // 左侧入口用 id，整页用 main 的 key，两者必须是同一个面板 id
  assert.deepEqual([...registered.keys()].sort(), ['main', 'sidebar.panellist'])
  assert.equal(registered.get('sidebar.panellist').spec.id, 'workbench')
  assert.equal(registered.get('main').spec.key, 'workbench')
  assert.equal(registered.get('sidebar.panellist').spec.label, '工作台')
  assert.equal(mod.inject.includes('slots'), true)
})

test('快照 → 行：只收工作目录、排除子智能体与草稿、认单号与收尾状态', async () => {
  const mod = await loadModule()
  const { ctx } = createCtx({
    notes: {
      'session-work': { outcome: '判定改到后端', next: '等发布窗口' },
      'session-sub': { next: '补重试测试' },
    },
  })
  const api = mod.apply(ctx)
  const rows = api.buildRows({
    'session-work': { outcome: '判定改到后端', next: '等发布窗口' },
    'session-sub': { next: '补重试测试' },
  }, '/Users/me/Desktop/work')

  assert.deepEqual(rows.map((row) => row.id).sort(), ['session-sub', 'session-work'])
  const work = rows.find((row) => row.id === 'session-work')
  assert.equal(work.status, 'done')
  assert.equal(work.ref, 'RO-20260923-028')
  assert.equal(work.project, 'work')
  assert.equal(work.next, '等发布窗口')

  const sub = rows.find((row) => row.id === 'session-sub')
  assert.equal(sub.status, 'open')
  assert.equal(sub.running, true)
  assert.equal(sub.ref, null)
})

test('行 → 周报草稿：本周完成按结论写，未收尾按下一步写', async () => {
  const mod = await loadModule()
  const { ctx } = createCtx()
  const api = mod.apply(ctx)
  const rows = api.buildRows({}, '/Users/me/Desktop/work')
  const draft = api.weeklyDraft(rows)
  assert.match(draft, /^## 本周完成/u)
  assert.match(draft, /## 进行中 \/ 未收尾/u)
})

test('单号识别覆盖 demand / task / 项目 / 缺陷', async () => {
  const mod = await loadModule()
  const { ctx } = createCtx()
  const api = mod.apply(ctx)
  assert.equal(api.refOf('RO-20260923-028 发票'), 'RO-20260923-028')
  assert.equal(api.refOf('T-20261026-016 改重试'), 'T-20261026-016')
  assert.equal(api.refOf('P-20260908-001 专项'), 'P-20260908-001')
  assert.equal(api.refOf('顺手改了插件'), null)
})

test('周窗口是周一到下周一', async () => {
  const mod = await loadModule()
  const { ctx } = createCtx()
  const api = mod.apply(ctx)
  const wednesday = new Date(2026, 10, 18, 15, 0, 0)
  const { start, end } = api.weekRange(wednesday)
  const startDate = new Date(start)
  assert.equal(startDate.getDay(), 1)
  assert.equal(startDate.getHours(), 0)
  assert.equal(end - start, 7 * 24 * 60 * 60 * 1000)
})
