import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Browser-half tests: load `client.js` the way the shell does, then drive the
 * record stream and the window activation that a clicked card causes.
 */

/** Definitions the fake module loader received. */
const definitions = []

/** @type {Map<string, Function>} */
let windowListeners = new Map()
/** @type {Map<string, Function>} */
let documentListeners = new Map()

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      definitions.push(definition)
    },
  },
  addEventListener(name, listener) {
    windowListeners.set(name, listener)
  },
  removeEventListener(name) {
    windowListeners.delete(name)
  },
  focus() {},
  setTimeout() {
    return 0
  },
}

globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  visibilityState: 'visible',
  hasFocus: () => true,
  addEventListener(name, listener) {
    documentListeners.set(name, listener)
  },
  removeEventListener(name) {
    documentListeners.delete(name)
  },
}

await import('../client.js')

assert.equal(definitions.length, 1, 'client.js must register exactly one module')
const plugin = definitions[0].factory(() => ({}))

/**
 * Install the browser stubs one test needs.
 * @param permission - `Notification.permission` this page reports.
 * @returns the cards the page created.
 */
function installBrowser(permission) {
  const created = []
  class FakeNotification {
    static permission = permission
    constructor(title, options) {
      this.title = title
      this.options = options
      this.closed = false
      created.push(this)
    }

    close() {
      this.closed = true
    }
  }
  globalThis.Notification = FakeNotification
  globalThis.fetch = async () => ({ ok: true })
  return created
}

/** Capture the one EventSource this page opens. */
let stream

globalThis.EventSource = class FakeEventSource {
  constructor(url) {
    this.url = url
    stream = this
  }

  close() {}
}

/**
 * Apply the plugin against a fake Client context.
 * @param options - page permission and the Workspace spy.
 * @returns the harness.
 */
function boot(options = {}) {
  windowListeners = new Map()
  documentListeners = new Map()
  const cards = installBrowser(options.permission ?? 'denied')
  const opened = []
  let openCalls = 0
  const workspace = {
    openSession(sessionId) {
      openCalls += 1
      if (options.failFirst === true && openCalls === 1) throw new Error('sessions.retain: unknown session')
      opened.push(sessionId)
    },
  }
  const refreshed = []
  const sessions = {
    async refresh() {
      refreshed.push(Date.now())
    },
  }
  const effects = []
  const ctx = {
    get(name) {
      if (name === 'uiWorkspace') return workspace
      if (name === 'sessions') return sessions
      return undefined
    },
    effect(register) {
      effects.push(register())
    },
  }
  plugin.apply(ctx)
  return {
    cards,
    opened,
    refreshed,
    effects,
    dispatch(record) {
      stream.onmessage({ data: JSON.stringify(record) })
    },
    focus() {
      for (const listener of windowListeners.values()) listener()
    },
    setFocused(value) {
      globalThis.document.hasFocus = () => value
    },
    teardown() {
      for (const dispose of effects) if (typeof dispose === 'function') dispose()
    },
  }
}

test('the page names itself on the stream so the Host can tell pages apart', () => {
  boot({ permission: 'granted' })
  assert.match(stream.url, /^\/plugins\/task-notify\/events\?page=/)
})

test('clicking a browser card opens the Session the record names', () => {
  const harness = boot({ permission: 'granted' })
  harness.dispatch({ kind: 'completed', sessionId: 'session-a', title: '报价单', body: '做好了' })

  assert.equal(harness.cards.length, 1)
  assert.equal(harness.cards[0].title, '任务完成 · 报价单')
  assert.equal(harness.cards[0].options.tag, 'dsh-task-notify:session-a')

  harness.cards[0].onclick()
  assert.deepEqual(harness.opened, ['session-a'])
  assert.equal(harness.cards[0].closed, true)
})

test('two Sessions keep their own card instead of replacing each other', () => {
  const harness = boot({ permission: 'granted' })
  harness.dispatch({ kind: 'completed', sessionId: 'session-a', title: 'A', body: '' })
  harness.dispatch({ kind: 'completed', sessionId: 'session-b', title: 'B', body: '' })
  assert.deepEqual(
    harness.cards.map((card) => card.options.tag),
    ['dsh-task-notify:session-a', 'dsh-task-notify:session-b'],
  )
})

test('a card the Host posted navigates when the window comes to the front', () => {
  const harness = boot({ permission: 'denied' })
  harness.setFocused(false)
  harness.dispatch({ kind: 'completed', sessionId: 'session-b', title: 'B', body: '', native: true })

  assert.equal(harness.cards.length, 0, 'a denied page never shows a card of its own')
  assert.deepEqual(harness.opened, [], 'the card click is still ahead')

  harness.setFocused(true)
  harness.focus()
  assert.deepEqual(harness.opened, ['session-b'], 'the activation follows the card')

  harness.focus()
  assert.deepEqual(harness.opened, ['session-b'], 'one card navigates once')
})

test('a card that arrives while this window is in front does not hijack a later focus', () => {
  const harness = boot({ permission: 'denied' })
  harness.setFocused(true)
  harness.dispatch({ kind: 'completed', sessionId: 'session-c', title: 'C', body: '', native: true })

  harness.setFocused(false)
  harness.focus()
  harness.setFocused(true)
  harness.focus()
  assert.deepEqual(harness.opened, [])
})

test('a Session this page has not catalogued yet is refreshed once and opened', async () => {
  const harness = boot({ permission: 'granted', failFirst: true })
  harness.dispatch({ kind: 'completed', sessionId: 'session-new', title: '新会话', body: '' })

  harness.cards[0].onclick()
  assert.equal(harness.opened.length, 0, 'the first attempt is refused by the catalog')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(harness.opened, ['session-new'])
  assert.equal(harness.refreshed.length, 1)
})

test('a record without a Session still shows its card and clicks harmlessly', () => {
  const harness = boot({ permission: 'granted' })
  harness.dispatch({ kind: 'completed', sessionId: '', title: '通知测试', body: '' })
  assert.equal(harness.cards.length, 1)
  harness.cards[0].onclick()
  assert.deepEqual(harness.opened, [])
})

test('a waiting card names the Session that is asking', () => {
  const { compose } = plugin._internals
  assert.deepEqual(
    compose({ kind: 'question', title: '报价单项目', body: '要加一列吗?' }),
    { title: '需要你回答 · 报价单项目', body: '要加一列吗?' },
  )
  assert.deepEqual(
    compose({ kind: 'question', title: '', body: '' }),
    { title: '需要你回答', body: '有一个操作在等你处理。' },
  )
})
