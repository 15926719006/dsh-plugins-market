import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  appleScriptOf,
  basenameOf,
  clip,
  isUserSession,
  kindOfReason,
  textOfMessage,
} from '../index.js'

test('textOfMessage joins text blocks and ignores everything else', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: '第一段' },
      { type: 'tool-call', name: 'bash' },
      { type: 'text', text: '第二段' },
    ],
  }
  assert.equal(textOfMessage(message), '第一段\n第二段')
  assert.equal(textOfMessage({ role: 'assistant' }), '')
  assert.equal(textOfMessage(null), '')
  assert.equal(textOfMessage({ content: 'not an array' }), '')
})

test('clip flattens whitespace and shortens with an ellipsis', () => {
  assert.equal(clip('  a\n\n b \t c '), 'a b c')
  assert.equal(clip('abcdef', 4), 'abc…')
  assert.equal(clip('abcd', 4), 'abcd')
  assert.equal(clip(undefined), '')
})

test('basenameOf reads the last path segment', () => {
  assert.equal(basenameOf('/Users/maka.li/Documents/work'), 'work')
  assert.equal(basenameOf('/Users/maka.li/Documents/work/'), 'work')
  assert.equal(basenameOf('C:\\tmp\\proj'), 'proj')
  assert.equal(basenameOf(''), '')
  assert.equal(basenameOf(undefined), '')
})

test('kindOfReason reads the turn end reason', () => {
  assert.equal(kindOfReason({ kind: 'completed' }), 'completed')
  assert.equal(kindOfReason({ kind: 'error', error: { code: 'x' } }), 'error')
  assert.equal(kindOfReason(undefined), 'unknown')
  assert.equal(kindOfReason({}), 'unknown')
})

test('isUserSession keeps top-level sessions and drops subagent work', () => {
  assert.equal(isUserSession({ id: 'root-1', header: { id: 'root-1' } }), true)
  assert.equal(isUserSession({ id: 'child-1', header: { origin: 'subagent' } }), false)
  assert.equal(isUserSession({ id: 'child-2', header: { delegationDepth: 2 } }), false)
  // A shared or missing header must never mute the user's own conversation.
  assert.equal(isUserSession({ id: 'other', header: {} }), true)
  assert.equal(isUserSession({ id: 'root-1' }), true)
  assert.equal(isUserSession(null), true)
})

test('appleScriptOf escapes quotes so one record cannot break the script', () => {
  const script = appleScriptOf({
    title: 'say "hi"',
    subtitle: '',
    body: 'path C:\\tmp',
  })
  assert.ok(script.startsWith('display notification "path C:\\\\tmp" with title "say \\"hi\\""'))
  assert.ok(script.includes('sound name "Glass"'))
})

// ---- Host wiring: run apply() against a fake context -----------------------

import { apply } from '../index.js'

/**
 * Build the smallest ctx the plugin needs, plus captured routes and listeners.
 * @param services - optional service overrides handed to `ctx.get`.
 * @returns the fake context and its recording surfaces.
 */
function fakeHost(services = {}) {
  const routes = new Map()
  const listeners = new Map()
  const ctx = {
    on(name, handler) {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
    effect(register) {
      const dispose = register()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    get(key) {
      return services[key]
    },
    logger: { warn() {} },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  return { ctx, routes, listeners }
}

/**
 * Open the plugin's event stream against a fake HTTP response.
 * @param routes - captured routes.
 * @returns the chunks the plugin writes, in order.
 */
function openStream(routes) {
  const chunks = []
  const handler = routes.get('/plugins/task-notify/events')
  handler(
    { on() {}, method: 'GET', url: '/plugins/task-notify/events' },
    {
      writeHead() {},
      write(chunk) {
        chunks.push(String(chunk))
        return true
      },
      end() {},
      on() {},
    },
  )
  return chunks
}

/**
 * Read the `data:` records out of a captured stream.
 * @param chunks - raw stream writes.
 * @returns the decoded records.
 */
function recordsOf(chunks) {
  const records = []
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue
      records.push(JSON.parse(line.slice('data: '.length)))
    }
  }
  return records
}

test('a completed turn reaches the browser as one finished record', () => {
  const { ctx, routes, listeners } = fakeHost()
  apply(ctx)
  const chunks = openStream(routes)

  const session = { id: 'session-1', header: { cwd: '/tmp/project' } }
  const push = listeners.get('session/event')
  assert.equal(typeof push, 'function', 'the plugin must listen to session events')

  push(session, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'skip' }, { type: 'text', text: '报价单做好了' }] } },
  })
  push(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const records = recordsOf(chunks)
  assert.equal(records.length, 1)
  assert.equal(records[0].kind, 'completed')
  assert.equal(records[0].title, 'project')
  assert.equal(records[0].body, '报价单做好了')
  assert.equal(records[0].sessionId, 'session-1')
})

test('a subagent session and a forked turn stay silent', () => {
  const { ctx, routes, listeners } = fakeHost()
  apply(ctx)
  const chunks = openStream(routes)
  const push = listeners.get('session/event')

  push({ id: 'child', header: { origin: 'subagent' } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  push({ id: 'forked', header: { cwd: '/tmp/p' } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'forked' } } })

  assert.deepEqual(recordsOf(chunks), [])
})

test('waiting for the user also reaches the browser', () => {
  const { ctx, routes, listeners } = fakeHost()
  apply(ctx)
  const chunks = openStream(routes)

  listeners.get('user-questions/request')({ questions: [{ question: '要不要加一列?' }] }, () => {})
  listeners.get('approval/request')({}, () => {})

  const records = recordsOf(chunks)
  assert.deepEqual(
    records.map((record) => record.kind),
    ['question', 'approval'],
  )
  assert.equal(records[0].body, '要不要加一列?')
})

test('the debug route reports what the listener actually saw', async () => {
  const { ctx, routes, listeners } = fakeHost()
  apply(ctx)
  openStream(routes)
  listeners.get('session/event')({ id: 'session-1', header: {} }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const handler = routes.get('/plugins/task-notify/debug')
  const body = await new Promise((resolve) => {
    handler(
      { on() {}, method: 'GET', url: '/plugins/task-notify/debug' },
      {
        writeHead() {},
        write(chunk) {
          return true
        },
        end(chunk) {
          resolve(String(chunk))
        },
        on() {},
      },
    )
  })
  const payload = JSON.parse(body)
  assert.equal(payload.stats.sessionEvent['turn/end'], 1)
  assert.equal(payload.stats.turnEnd.completed, 1)
  assert.equal(payload.stats.emitted, 1)
  assert.deepEqual(payload.stats.errors, [])
})
