/**
 * Unit and route-contract tests for the Host half of `@local/session-rename`.
 *
 * The Host reads a Session's event log through `ctx.sessionQuery.observeSession`,
 * so the tests build raw `user/message`, `assistant/message`, `request/header`
 * and `session/title` events instead of derived messages.
 *
 * Run with: node --test test/rename.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ROUTE,
  STATUS_ROUTE,
  TITLE_SYSTEM_PROMPT,
  apply,
  buildTranscript,
  cleanTitle,
  devopsPrefixEnabled,
  inject,
  name,
} from '../index.js'
import { composeDevopsTitle, DEVOPS_SUMMARY_PROMPT } from '../lib/title.mjs'
import { findDevopsRefs, primaryDevopsRef } from '../lib/devops/devops-refs.mjs'

/** UTF-8 size of one string. */
const bytes = (text) => Buffer.byteLength(text, 'utf8')

// ---------------------------------------------------------------------------
// Event fixtures, shaped like the events `observeSession` returns
// ---------------------------------------------------------------------------

let nextSeq = 0

/** One human-authored `user/message` event. */
function userEvent(text, options = {}) {
  return {
    type: 'user/message',
    seq: nextSeq++,
    time: 0,
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      source: options.source ?? { kind: 'user' },
      ...options.data,
    },
    surfaceOp: options.surfaceOp ?? 'append',
  }
}

/** One `assistant/message` event. */
function assistantEvent(content) {
  return {
    type: 'assistant/message',
    seq: nextSeq++,
    time: 0,
    data: {
      message: {
        id: `assistant-${nextSeq}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
      },
      turn: 0,
      step: 0,
    },
    surfaceOp: 'append',
  }
}

/** One `tool/result` event, which must never be summarized. */
function toolResultEvent(text) {
  return {
    type: 'tool/result',
    seq: nextSeq++,
    time: 0,
    data: { message: { id: 'tool-1', role: 'tool', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text }] } },
    surfaceOp: 'append',
  }
}

/** One `request/header` event recording the model route. */
function headerEvent(config) {
  return {
    type: 'request/header',
    seq: nextSeq++,
    time: 0,
    data: { header: { config }, reason: 'series', startsSeries: true },
  }
}

/** One accepted `session/title` event. */
function titleEvent(title) {
  return {
    type: 'session/title',
    seq: nextSeq++,
    time: 0,
    data: { title, messageSeqs: [], source: { kind: 'user' } },
  }
}

// ---------------------------------------------------------------------------
// buildTranscript
// ---------------------------------------------------------------------------

test('buildTranscript keeps human user text and assistant text', () => {
  const { messages, truncated } = buildTranscript([
    userEvent('Fix the failing build'),
    assistantEvent('Looking at the log now.'),
    toolResultEvent('command output that must not be summarized'),
    headerEvent({ provider: 'p', model: 'm' }),
    titleEvent('an older title'),
    userEvent('Thanks, ship it'),
  ])

  assert.equal(truncated, false)
  assert.deepEqual(messages, [
    { role: 'user', text: 'Fix the failing build' },
    { role: 'assistant', text: 'Looking at the log now.' },
    { role: 'user', text: 'Thanks, ship it' },
  ])
})

test('buildTranscript skips non-human user messages', () => {
  const { messages } = buildTranscript([
    userEvent('Real question'),
    userEvent('injected title input', { source: { kind: 'dsh-session-title-llm' } }),
    userEvent('no source kind', { source: { kind: 'plugin' } }),
    userEvent('source stripped', { data: { source: undefined } }),
  ])

  assert.deepEqual(messages, [{ role: 'user', text: 'Real question' }])
})

test('buildTranscript skips tool-call, reasoning, image and file blocks', () => {
  const { messages } = buildTranscript([
    {
      type: 'user/message',
      seq: 0,
      time: 0,
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: '见了这张图' },
          { type: 'image', variantId: 'v1' },
          { type: 'file', ref: 'f1' },
        ],
      },
      surfaceOp: 'append',
    },
    assistantEvent([
      { type: 'reasoning', text: 'internal thinking' },
      { type: 'text', text: 'I read the image.' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
    ]),
    assistantEvent([{ type: 'tool-call', id: 'c2', name: 'grep', arguments: '{}' }]),
  ])

  assert.deepEqual(messages, [
    { role: 'user', text: '见了这张图' },
    { role: 'assistant', text: 'I read the image.' },
  ])
})

test('buildTranscript joins multiple text blocks and drops empty text', () => {
  const { messages } = buildTranscript([
    {
      type: 'user/message',
      seq: 0,
      time: 0,
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'first paragraph' },
          { type: 'text', text: 'second paragraph' },
        ],
      },
      surfaceOp: 'append',
    },
    userEvent('   '),
    assistantEvent([]),
    null,
  ])

  assert.deepEqual(messages, [{ role: 'user', text: 'first paragraph\nsecond paragraph' }])
})

test('buildTranscript returns empty messages for empty or non-array input', () => {
  assert.deepEqual(buildTranscript([]), { messages: [], truncated: false })
  assert.deepEqual(buildTranscript(undefined), { messages: [], truncated: false })
  assert.deepEqual(buildTranscript(null), { messages: [], truncated: false })
})

test('buildTranscript keeps the first user message and the latest eight messages', () => {
  const events = [userEvent('first task')]
  for (let index = 0; index < 20; index += 1) {
    events.push(index % 2 === 0 ? assistantEvent(`reply ${index}`) : userEvent(`follow up ${index}`))
  }

  const { messages, truncated } = buildTranscript(events)

  assert.equal(truncated, true)
  assert.equal(messages.length, 9)
  assert.deepEqual(messages[0], { role: 'user', text: 'first task' })
  assert.deepEqual(messages.at(-1), { role: 'user', text: 'follow up 19' })
  assert.equal(messages.some((message) => message.text === 'reply 8'), false)
})

test('buildTranscript pins the first user message even when the log starts with assistant text', () => {
  const events = [assistantEvent('resumed summary'), userEvent('the actual task')]
  for (let index = 0; index < 12; index += 1) events.push(assistantEvent(`reply ${index}`))

  const { messages, truncated } = buildTranscript(events)

  assert.equal(truncated, true)
  assert.deepEqual(messages[0], { role: 'user', text: 'the actual task' })
  assert.equal(messages.some((message) => message.text === 'resumed summary'), false)
})

test('buildTranscript respects the byte budget and keeps the first user message', () => {
  const events = [userEvent('first')]
  for (let index = 0; index < 20; index += 1) events.push(assistantEvent('a'.repeat(100)))

  const { messages, truncated } = buildTranscript(events, { maxBytes: 250 })

  assert.equal(truncated, true)
  assert.equal(messages[0].text, 'first')
  assert.ok(bytes(messages.map((message) => message.text).join('')) <= 250)
})

test('buildTranscript truncates an oversized first message to the budget', () => {
  const { messages, truncated } = buildTranscript([userEvent('x'.repeat(100))], { maxBytes: 20 })

  assert.equal(truncated, true)
  assert.deepEqual(messages, [{ role: 'user', text: 'x'.repeat(20) }])
})

test('buildTranscript does not split a multi-byte code point when truncating', () => {
  const { messages } = buildTranscript([userEvent('中文标题内容')], { maxBytes: 7 })

  assert.deepEqual(messages, [{ role: 'user', text: '中文' }])
  assert.ok(bytes(messages[0].text) <= 7)
})

test('buildTranscript caps an oversized opening so the latest context survives', () => {
  const events = [userEvent('x'.repeat(20000))]
  for (let index = 0; index < 4; index += 1) events.push(assistantEvent(`recent reply ${index}`))

  const { messages, truncated } = buildTranscript(events)

  assert.equal(truncated, true)
  // The opening keeps at most 40% of the budget and the trailing window is intact.
  assert.ok(bytes(messages[0].text) <= Math.floor(8192 * 0.4))
  assert.deepEqual(messages.slice(1), [
    { role: 'assistant', text: 'recent reply 0' },
    { role: 'assistant', text: 'recent reply 1' },
    { role: 'assistant', text: 'recent reply 2' },
    { role: 'assistant', text: 'recent reply 3' },
  ])
  assert.ok(bytes(messages.map((message) => message.text).join('')) <= 8192)
})

test('buildTranscript keeps an opening that already fits the budget', () => {
  const { messages, truncated } = buildTranscript([
    userEvent('x'.repeat(5000)),
    assistantEvent('ok'),
  ])

  assert.equal(truncated, false)
  assert.equal(messages[0].text.length, 5000)
  assert.deepEqual(messages[1], { role: 'assistant', text: 'ok' })
})

test('buildTranscript ignores replacement surface nodes', () => {
  const { messages } = buildTranscript([
    userEvent('the task the human saw'),
    userEvent('a landed replacement the human never saw', { surfaceOp: 'replace' }),
  ])

  assert.deepEqual(messages, [{ role: 'user', text: 'the task the human saw' }])
})

// ---------------------------------------------------------------------------
// cleanTitle
// ---------------------------------------------------------------------------

test('cleanTitle strips whole-line emphasis and quote wrappers', () => {
  assert.equal(cleanTitle('**修复构建失败**'), '修复构建失败')
  assert.equal(cleanTitle('*修复构建失败*'), '修复构建失败')
  assert.equal(cleanTitle('`修复构建失败`'), '修复构建失败')
  assert.equal(cleanTitle('"修复构建失败"'), '修复构建失败')
  assert.equal(cleanTitle("'修复构建失败'"), '修复构建失败')
  assert.equal(cleanTitle('“修复构建失败”'), '修复构建失败')
  assert.equal(cleanTitle('「修复构建失败」'), '修复构建失败')
  assert.equal(cleanTitle('**"修复构建失败"**'), '修复构建失败')
})

test('cleanTitle strips list prefixes', () => {
  assert.equal(cleanTitle('- 修复构建失败'), '修复构建失败')
  assert.equal(cleanTitle('* 修复构建失败'), '修复构建失败')
  assert.equal(cleanTitle('1. 修复构建失败'), '修复构建失败')
  assert.equal(cleanTitle('2) 修复构建失败'), '修复构建失败')
  assert.equal(cleanTitle('- **修复构建失败**'), '修复构建失败')
})

test('cleanTitle strips Markdown heading, quote and label prefixes', () => {
  assert.equal(cleanTitle('# 修复构建失败'), '修复构建失败')
  assert.equal(cleanTitle('### 修复构建失败'), '修复构建失败')
  assert.equal(cleanTitle('> 修复构建失败'), '修复构建失败')
  assert.equal(cleanTitle('Title: Fix the build'), 'Fix the build')
  assert.equal(cleanTitle('标题：修复构建失败'), '修复构建失败')
  assert.equal(cleanTitle('**标题：修复构建失败**'), '修复构建失败')
})

test('cleanTitle never accepts a fence, table rule or bare punctuation as a title', () => {
  assert.equal(cleanTitle('```'), '')
  assert.equal(cleanTitle('```js'), '')
  assert.equal(cleanTitle('!!!'), '')
  assert.equal(cleanTitle('** **'), '')
  assert.equal(cleanTitle('---'), '')
  assert.equal(cleanTitle('| --- | --- |'), '')
  // A fenced first line is skipped; the real title below it is used.
  assert.equal(cleanTitle('```\n修复构建失败\n```'), '修复构建失败')
})

test('cleanTitle uses the first non-empty line', () => {
  assert.equal(cleanTitle('第一行标题\n第二行是解释'), '第一行标题')
  assert.equal(cleanTitle('\n\n  **第一行标题**  \n说明\n'), '第一行标题')
})

test('cleanTitle removes control characters and collapses whitespace', () => {
  assert.equal(cleanTitle('标\u0000题\u0007'), '标题')
  assert.equal(cleanTitle('标\u007f题\u009f'), '标题')
  assert.equal(cleanTitle('标\u202e题\u2066'), '标题')
  assert.equal(cleanTitle('  修复\t\t构建  失败  '), '修复 构建 失败')
})

test('cleanTitle returns an empty string when nothing usable remains', () => {
  assert.equal(cleanTitle(''), '')
  assert.equal(cleanTitle('   '), '')
  assert.equal(cleanTitle('\n\n\t\n'), '')
  assert.equal(cleanTitle(null), '')
  assert.equal(cleanTitle(undefined), '')
  assert.equal(cleanTitle(42), '')
})

test('cleanTitle enforces the UTF-8 byte limit without splitting a code point', () => {
  assert.equal(cleanTitle('中文标题', 6), '中文')
  assert.ok(bytes(cleanTitle('中文标题', 7)) <= 7)
  assert.equal(cleanTitle('abcdef', 3), 'abc')
  assert.equal(cleanTitle('**修复构建失败**', 6), '修复')
})

// ---------------------------------------------------------------------------
// Prompt and module metadata
// ---------------------------------------------------------------------------

test('module exposes the Cordis name, inject list and route', () => {
  assert.equal(name, 'session-rename')
  assert.deepEqual(inject, ['connection', 'sessionQuery', 'sessionController', 'llm'])
  assert.equal(ROUTE, '/api/session-rename')
})

test('TITLE_SYSTEM_PROMPT asks for one clean title in the conversation language', () => {
  assert.equal(typeof TITLE_SYSTEM_PROMPT, 'string')
  assert.match(TITLE_SYSTEM_PROMPT, /title/i)
  assert.match(TITLE_SYSTEM_PROMPT, /language/i)
  assert.match(TITLE_SYSTEM_PROMPT, /single line/i)
})

// ---------------------------------------------------------------------------
// Route contract
// ---------------------------------------------------------------------------

/** A POST request for the route, with an optional body. */
function post(body) {
  const init = { method: 'POST', headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  return new Request('http://127.0.0.1:52740/api/session-rename', init)
}

/** A `SessionQueryError` stand-in, discriminated by `code` like the real one. */
function sessionQueryError(code) {
  const error = new Error(`session query failed: ${code}`)
  error.name = 'SessionQueryError'
  error.code = code
  return error
}

/** The default log every route test starts from. */
function defaultEvents() {
  return [
    userEvent('帮我修复构建失败'),
    assistantEvent('已经修复并跑完测试'),
    headerEvent({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
  ]
}

/**
 * Build a fake Host context, apply the plugin, and return the captured handler.
 * @param {object} options - event log, fake model, fake services and overrides.
 */
function harness(options = {}) {
  const state = {
    registration: undefined,
    registrations: [],
    streams: [],
    renames: [],
    warnings: [],
    disposed: 0,
    observes: [],
  }
  const events = options.events ?? defaultEvents()

  const observe = options.observe ?? (async (sessionId, observeOptions) => {
    state.observes.push({ sessionId, options: observeOptions })
    return {
      events,
      header: { id: sessionId, version: 4 },
      cursor: events.at(-1)?.seq ?? -1,
      [Symbol.dispose]: () => {
        state.disposed += 1
      },
    }
  })

  const rename = options.rename ?? (async (request) => {
    state.renames.push(request)
    return { title: request.title, seq: 7 }
  })

  const llm = options.llm ?? {
    prepareCall: async (config, _signal, configure) => {
      // Select the least effort the fake model supports, like the live runtime.
      const controls = configure === undefined ? config : configure(config, { reasoning: { efforts: [{ id: 'low' }] } })
      const prepared = {
        provider: config.provider,
        model: config.model,
        maxTokens: config.maxTokens,
        reasoningEffort: controls.reasoningEffort,
      }
      return {
        config: prepared,
        stream: async function* (streamOptions) {
          state.streams.push(streamOptions)
          yield { type: 'text-delta', index: 0, text: '  **修复构建失败**  ' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }

  const ctx = {
    logger: { warn: (message) => state.warnings.push(String(message)) },
    effect: (callback) => callback(),
    get: (serviceName) => options.services?.[serviceName],
    connection: {
      fetch: {
        register: (registration) => {
          state.registration = registration
          state.registrations.push(registration)
          return () => {}
        },
      },
    },
    sessionQuery: { observeSession: observe },
    sessionController: Object.hasOwn(options, 'controller') ? options.controller : { rename },
    llm,
  }

  apply(ctx, options.config)
  const summarize = state.registrations.find((registration) => registration.path === ROUTE)
  const status = state.registrations.find((registration) => registration.path === STATUS_ROUTE)
  return { state, handler: summarize.fetch, statusHandler: status.fetch }
}

test('apply registers the summarize POST route and the devops status GET route', () => {
  const { state } = harness()

  const summarize = state.registrations.find((registration) => registration.path === ROUTE)
  const status = state.registrations.find((registration) => registration.path === STATUS_ROUTE)
  assert.deepEqual(summarize.methods, ['POST'])
  assert.equal(summarize.requestBody, 'buffered')
  assert.equal(typeof summarize.fetch, 'function')
  assert.deepEqual(status.methods, ['GET'])
  assert.equal(typeof status.fetch, 'function')
})

test('route observes the session, renames it and returns the accepted title', async () => {
  const { state, handler } = harness()

  const response = await handler(post({ sessionId: 'session-1' }))

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, title: '修复构建失败' })

  assert.equal(state.observes.length, 1)
  assert.equal(state.observes[0].sessionId, 'session-1')
  assert.equal(state.observes[0].options.projectionMode, 'none')
  assert.ok(state.observes[0].options.signal instanceof AbortSignal)
  assert.equal(state.disposed, 1, 'the observation lease is released')

  assert.equal(state.renames.length, 1)
  assert.deepEqual(state.renames[0], { sessionId: 'session-1', title: '修复构建失败' })
})

test('route calls the model recorded by the latest request header', async () => {
  const { state, handler } = harness({
    events: [
      userEvent('帮我修复构建失败'),
      headerEvent({ provider: 'old-provider', model: 'old-model' }),
      assistantEvent('已经修复'),
      headerEvent({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
    ],
  })

  await handler(post({ sessionId: 'session-1' }))

  assert.equal(state.streams.length, 1)
  const call = state.streams[0]
  assert.equal(call.provider, 'deepseek-official')
  assert.equal(call.model, 'deepseek-v4-flash')
  assert.equal(call.system, TITLE_SYSTEM_PROMPT)
  assert.equal(call.sessionId, 'session-1')
  assert.equal(call.purpose, 'session-rename')
  assert.equal(call.maxTokens, 4096)
  assert.equal(call.reasoningEffort, 'low')
  assert.ok(call.signal instanceof AbortSignal)
  assert.equal(call.signal.aborted, false)

  assert.equal(call.messages.length, 1)
  assert.equal(call.messages[0].role, 'user')
  assert.equal(call.messages[0].content.length, 1)
  assert.equal(call.messages[0].content[0].type, 'text')
  assert.deepEqual(JSON.parse(call.messages[0].content[0].text), {
    currentTitle: null,
    messages: [
      { role: 'user', text: '帮我修复构建失败' },
      { role: 'assistant', text: '已经修复' },
    ],
  })
})

test('route sends the latest accepted title and prefers the accepted snapshot title', async () => {
  const { state, handler } = harness({
    events: [
      userEvent('帮我修复构建失败'),
      assistantEvent('已经修复'),
      headerEvent({ provider: 'p', model: 'm' }),
      titleEvent('更早的标题'),
      titleEvent('旧的标题'),
    ],
    rename: async (request) => {
      state.renames.push(request)
      return { title: '接受后的标题', seq: 9 }
    },
  })

  const response = await handler(post({ sessionId: 'session-1' }))

  assert.deepEqual(await response.json(), { ok: true, title: '接受后的标题' })
  assert.equal(state.renames[0].title, '修复构建失败')
  const payload = JSON.parse(state.streams[0].messages[0].content[0].text)
  assert.equal(payload.currentTitle, '旧的标题')
})

test('route rejects a body that is not JSON with 400 text', async () => {
  const { handler } = harness()

  const response = await handler(post('{not json'))

  assert.equal(response.status, 400)
  assert.match(await response.text(), /json/i)
})

test('route rejects a missing sessionId with 400 text', async () => {
  const { handler } = harness()

  for (const body of [{}, { sessionId: '' }, { sessionId: '   ' }, { sessionId: 42 }]) {
    const response = await handler(post(body))
    assert.equal(response.status, 400)
    assert.match(await response.text(), /sessionid/i)
  }
})

test('route reports an unknown session as session-missing with HTTP 200', async () => {
  const { handler } = harness({
    observe: async () => {
      throw sessionQueryError('SESSION_QUERY_SESSION_NOT_FOUND')
    },
  })

  const response = await handler(post({ sessionId: 'gone' }))

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'session-missing', message: '找不到这个会话：它可能已经被删除，刷新页面后再试' },
  })
})

test('route reports a conversation without user messages as no-messages', async () => {
  const { handler } = harness({ events: [assistantEvent('a reply with no human question')] })

  const response = await handler(post({ sessionId: 'session-1' }))
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'no-messages')
  assert.equal(typeof body.error.message, 'string')
})

test('route reports a session without a model route as no-route', async () => {
  const { handler } = harness({ events: [userEvent('hello')] })

  const response = await handler(post({ sessionId: 'session-1' }))
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'no-route')
})

test('route reports a non-stop finish as model-error', async () => {
  const { handler } = harness({
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '半截标' }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      },
    },
  })

  const response = await handler(post({ sessionId: 'session-1' }))
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'model-error')
})

test('route reports an empty model output as empty-title', async () => {
  const { handler } = harness({
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '   ' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })

  const response = await handler(post({ sessionId: 'session-1' }))
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'empty-title')
})

test('route reports a rejecting rename as a coded failure, not a 500', async () => {
  const error = new Error('title rejected')
  error.name = 'RemoteError'
  error.code = 'session/title-invalid'
  const { handler } = harness({ rename: async () => { throw error } })

  const response = await handler(post({ sessionId: 'session-1' }))
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'empty-title')
})

test('route answers an unexpected failure with 500 text and a warning', async () => {
  const { state, handler } = harness({
    observe: async () => {
      throw new Error('session store is corrupt')
    },
  })

  const response = await handler(post({ sessionId: 'session-1' }))

  assert.equal(response.status, 500)
  assert.match(await response.text(), /unexpected/i)
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /session store is corrupt/)
})

test('route falls back to a live session when no session controller is mounted', async () => {
  const liveSession = { id: 'session-1' }
  const renames = []
  const { state, handler } = harness({
    controller: undefined,
    services: {
      sessions: { get: (sessionId) => (sessionId === 'session-1' ? liveSession : undefined) },
      sessionTitle: {
        rename: (session, title) => {
          renames.push({ session, title })
          return { title, eventSeq: 3 }
        },
      },
    },
  })

  const response = await handler(post({ sessionId: 'session-1' }))

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, title: '修复构建失败' })
  assert.equal(state.renames.length, 0)
  assert.deepEqual(renames, [{ session: liveSession, title: '修复构建失败' }])
})

test('route succeeds with a single user message', async () => {
  const { handler } = harness({ events: [userEvent('只有一条用户消息'), headerEvent({ provider: 'p', model: 'm' })] })

  const response = await handler(post({ sessionId: 'session-1' }))

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, title: '修复构建失败' })
})

test('route maps a prepareCall failure to model-error', async () => {
  const { handler } = harness({
    llm: { prepareCall: async () => { throw new Error('no adapter registered') } },
  })

  const body = await (await handler(post({ sessionId: 'session-1' }))).json()

  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'model-error')
})

test('route maps a throwing stream to model-error', async () => {
  const { handler } = harness({
    llm: {
      stream: async function* () {
        throw new Error('stream exploded')
      },
    },
  })

  const body = await (await handler(post({ sessionId: 'session-1' }))).json()

  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'model-error')
})

test('route maps a stream without a finish chunk to model-error', async () => {
  const { handler } = harness({
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '半截标题' }
      },
    },
  })

  const body = await (await handler(post({ sessionId: 'session-1' }))).json()

  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'model-error')
  assert.match(body.error.message, /结束标记/)
})

test('route maps a caller cancellation to cancelled, not timeout', async () => {
  const controller = new AbortController()
  const { handler } = harness({
    llm: {
      stream: async function* () {
        controller.abort()
        yield { type: 'finish', reason: { kind: 'aborted' } }
      },
    },
  })
  const request = new Request('http://127.0.0.1:52740/api/session-rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-1' }),
    signal: controller.signal,
  })

  const body = await (await handler(request)).json()

  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'cancelled')
})

test('route refuses a second concurrent request for the same Session', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { state, handler } = harness({
    llm: {
      prepareCall: async (config) => ({
        config,
        stream: async function* () {
          state.streams.push(config)
          await gate
          yield { type: 'text-delta', index: 0, text: '并发标题' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
  })

  const first = handler(post({ sessionId: 'session-1' }))
  const second = await (await handler(post({ sessionId: 'session-1' }))).json()
  release()
  const firstBody = await (await first).json()

  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'busy')
  assert.equal(state.streams.length, 1, 'only one model call is paid for')
  assert.deepEqual(firstBody, { ok: true, title: '并发标题' })
})

test('route maps an agent-managed Session to unavailable', async () => {
  const error = new Error('agent busy')
  error.name = 'RemoteError'
  error.code = 'session/agent-busy'
  const { handler } = harness({ rename: async () => { throw error } })

  const body = await (await handler(post({ sessionId: 'session-1' }))).json()

  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'unavailable')
})

test('route maps a writer-held Session to locked', async () => {
  const error = new Error('writer held')
  error.name = 'RemoteError'
  error.code = 'session/writer-held'
  const { handler } = harness({ rename: async () => { throw error } })

  const body = await (await handler(post({ sessionId: 'session-1' }))).json()

  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'locked')
})

test('route respects the live title service byte budget', async () => {
  const { handler } = harness({
    services: { sessionTitle: { config: { maxTitleBytes: 6 } } },
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '中文标题内容' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })

  const body = await (await handler(post({ sessionId: 'session-1' }))).json()

  assert.deepEqual(body, { ok: true, title: '中文' })
})

// ---------------------------------------------------------------------------
// DevOps prefix: pure composition and reference extraction
// ---------------------------------------------------------------------------

test('composeDevopsTitle keeps the platform title and summary inside the budget', () => {
  assert.equal(composeDevopsTitle({
    number: 'RO-20261027-008',
    platformTitle: '收银台支付结果倒计时不跳转修复',
    summary: '修复倒计时跳转',
    maxBytes: 240,
  }), 'RO-20261027-008 收银台支付结果倒计时不跳转修复｜修复倒计时跳转')
})

test('composeDevopsTitle shortens the platform title but keeps a summary', () => {
  const platformTitle = '收银台支付结果倒计时不跳转修复及 returnUrl 兜底处理'
  const title = composeDevopsTitle({
    number: 'RO-20261027-008',
    platformTitle,
    summary: '修复倒计时跳转',
    maxBytes: 90,
  })

  assert.ok(Buffer.byteLength(title, 'utf8') <= 90)
  assert.match(title, /^RO-20261027-008 /)
  assert.match(title, /修复倒计$/)
  assert.equal(title.includes('｜｜'), false)
  assert.ok(title.length < `RO-20261027-008 ${platformTitle}｜修复倒计时跳转`.length)
})

test('composeDevopsTitle degrades to number｜summary when the prefix does not fit', () => {
  const title = composeDevopsTitle({
    number: 'RO-20261027-008',
    platformTitle: '一个很长很长很长很长很长很长的平台标题',
    summary: '修复倒计时跳转',
    maxBytes: 32,
  })

  assert.ok(Buffer.byteLength(title, 'utf8') <= 32)
  assert.equal(title, 'RO-20261027-008｜修复倒计')
})

test('composeDevopsTitle handles a missing summary or platform title', () => {
  assert.equal(composeDevopsTitle({ number: 'T-20261026-016', platformTitle: '任务标题', summary: '' }), 'T-20261026-016 任务标题')
  assert.equal(composeDevopsTitle({ number: 'T-20261026-016', platformTitle: '', summary: '做完了' }), 'T-20261026-016｜做完了')
  assert.equal(composeDevopsTitle({ number: '', platformTitle: 'x', summary: 'y' }), '')
})

test('composeDevopsTitle never splits a multi-byte code point', () => {
  const title = composeDevopsTitle({
    number: 'RO-20261027-008',
    platformTitle: '中文标题内容',
    summary: '总结内容',
    maxBytes: 36,
  })

  assert.ok(Buffer.byteLength(title, 'utf8') <= 36)
  assert.equal(/\uFFFD/u.test(title), false)
})

test('findDevopsRefs finds demand, task and release links and bare numbers', () => {
  const refs = findDevopsRefs([
    '看下 https://devops.ronhan.com/#demand/RO-20261027-008?mode=edit',
    '以及 https://devops.ronhan.com/task/373000146054680576',
    '还有 https://devops.ronhan.com/#release/order/RO-20261020-018',
    '纯文本 T-20261026-016 也算',
    '重复的 RO-20261027-008',
  ].join('\n'))

  const kinds = refs.map((ref) => ref.kind)
  assert.ok(kinds.includes('demand'))
  assert.ok(kinds.includes('task'))
  assert.ok(kinds.includes('release'))
  assert.equal(refs.filter((ref) => ref.ref === 'RO-20261027-008').length, 1)
  assert.equal(primaryDevopsRef(refs).ref, 'RO-20261027-008')
})

test('DEVOPS_SUMMARY_PROMPT asks for the summary only', () => {
  assert.match(DEVOPS_SUMMARY_PROMPT, /never repeat/i)
  assert.match(DEVOPS_SUMMARY_PROMPT, /summary/i)
})

test('devopsPrefixEnabled reads a volatile ref, a plain value and the default', () => {
  assert.equal(devopsPrefixEnabled(undefined), false)
  assert.equal(devopsPrefixEnabled({}), false)
  assert.equal(devopsPrefixEnabled({ prefixDevops: { get: () => true } }), true)
  assert.equal(devopsPrefixEnabled({ prefixDevops: true }), true)
  assert.equal(devopsPrefixEnabled({ prefixDevops: false }), false)
})

// ---------------------------------------------------------------------------
// DevOps prefix: route behaviour
// ---------------------------------------------------------------------------

/** Stub global fetch for the devops read routes used by the resolver. */
function withDevopsFetch(handler, callback) {
  const previous = globalThis.fetch
  globalThis.fetch = handler
  return Promise.resolve(callback()).finally(() => {
    globalThis.fetch = previous
  })
}

/** Run callback with temporary devops env credentials. */
function withDevopsEnv(callback) {
  const previousToken = process.env.DEVOPS_TOKEN
  const previousBase = process.env.DEVOPS_BASE_URL
  process.env.DEVOPS_TOKEN = 'test-token'
  process.env.DEVOPS_BASE_URL = 'https://devops.test'
  return Promise.resolve(callback()).finally(() => {
    if (previousToken === undefined) delete process.env.DEVOPS_TOKEN
    else process.env.DEVOPS_TOKEN = previousToken
    if (previousBase === undefined) delete process.env.DEVOPS_BASE_URL
    else process.env.DEVOPS_BASE_URL = previousBase
  })
}

/** A demand detail envelope for the mocked platform. */
function demandDetailResponse() {
  return new Response(JSON.stringify({
    respCode: '20000',
    respMsg: 'Success',
    data: { order: { orderId: 'RO-20261027-008', title: '收银台支付结果倒计时不跳转修复' } },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('route prefixes the title when the switch is on and a devops link resolves', async () => {
  await withDevopsEnv(async () => {
    await withDevopsFetch(async (url) => {
      if (String(url).includes('/api/devops/demand/detail/RO-20261027-008')) return demandDetailResponse()
      return new Response('{}', { status: 404 })
    }, async () => {
      const { handler } = harness({
        events: [
          userEvent('看下这个需求 https://devops.ronhan.com/#demand/RO-20261027-008?mode=edit'),
          assistantEvent('已经修好了'),
          headerEvent({ provider: 'p', model: 'm' }),
        ],
        config: { prefixDevops: { get: () => true } },
        services: { sessionTitle: { config: { maxTitleBytes: 240 } } },
        llm: {
          stream: async function* () {
            yield { type: 'text-delta', index: 0, text: '修复倒计时跳转' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        },
      })

      const body = await (await handler(post({ sessionId: 'session-1' }))).json()

      assert.deepEqual(body, {
        ok: true,
        title: 'RO-20261027-008 收银台支付结果倒计时不跳转修复｜修复倒计时跳转',
      })
    })
  })
})

test('route falls back to the plain summary when the devops record is unreadable', async () => {
  await withDevopsEnv(async () => {
    await withDevopsFetch(async () => new Response('{}', { status: 404 }), async () => {
      const { handler } = harness({
        events: [
          userEvent('看下这个需求 https://devops.ronhan.com/#demand/RO-20261027-008'),
          assistantEvent('已经修好了'),
          headerEvent({ provider: 'p', model: 'm' }),
        ],
        config: { prefixDevops: { get: () => true } },
        services: { sessionTitle: { config: { maxTitleBytes: 240 } } },
        llm: {
          stream: async function* () {
            yield { type: 'text-delta', index: 0, text: '修复倒计时跳转' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        },
      })

      const body = await (await handler(post({ sessionId: 'session-1' }))).json()

      assert.deepEqual(body, { ok: true, title: '修复倒计时跳转' })
    })
  })
})

test('route keeps the plain summary when the switch is off', async () => {
  const { handler } = harness({
    events: [
      userEvent('看下这个需求 https://devops.ronhan.com/#demand/RO-20261027-008'),
      headerEvent({ provider: 'p', model: 'm' }),
    ],
    config: { prefixDevops: { get: () => false } },
    services: { sessionTitle: { config: { maxTitleBytes: 240 } } },
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '修复倒计时跳转' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })

  const body = await (await handler(post({ sessionId: 'session-1' }))).json()

  assert.deepEqual(body, { ok: true, title: '修复倒计时跳转' })
})

test('status route reports the switch, credential readiness and title budget', async () => {
  const { statusHandler } = harness({
    config: { prefixDevops: { get: () => true } },
    services: { sessionTitle: { config: { maxTitleBytes: 240 } } },
  })

  const body = await (await statusHandler({ method: 'GET' })).json()

  assert.equal(body.ok, true)
  assert.equal(body.prefixDevops, true)
  assert.equal(body.titleBudget, 240)
  assert.equal(typeof body.devops.hasToken, 'boolean')
  assert.equal(typeof body.devops.source, 'string')
  assert.equal(Object.hasOwn(body.devops, 'token'), false)
})

test('route tries later devops references when the first one is unreadable', async () => {
  await withDevopsEnv(async () => {
    await withDevopsFetch(async (url, init) => {
      if (String(url).includes('/api/devops/defect/detail/')) return new Response('{}', { status: 404 })
      if (String(url).includes('/api/devops/demand/detail/RO-20261027-008')) return demandDetailResponse()
      return new Response('{}', { status: 404 })
    }, async () => {
      const { handler } = harness({
        events: [
          userEvent('先看缺陷 https://devops.ronhan.com/#defect/BUG-20261022-006 再看需求 https://devops.ronhan.com/#demand/RO-20261027-008'),
          headerEvent({ provider: 'p', model: 'm' }),
        ],
        config: { prefixDevops: { get: () => true } },
        services: { sessionTitle: { config: { maxTitleBytes: 240 } } },
        llm: {
          stream: async function* () {
            yield { type: 'text-delta', index: 0, text: '修复倒计时跳转' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        },
      })

      const body = await (await handler(post({ sessionId: 'session-1' }))).json()

      assert.deepEqual(body, {
        ok: true,
        title: 'RO-20261027-008 收银台支付结果倒计时不跳转修复｜修复倒计时跳转',
      })
    })
  })
})

test('route does not repeat a devops prefix the model wrote itself', async () => {
  await withDevopsEnv(async () => {
    await withDevopsFetch(async (url) => {
      if (String(url).includes('/api/devops/demand/detail/RO-20261027-008')) return demandDetailResponse()
      return new Response('{}', { status: 404 })
    }, async () => {
      const { handler } = harness({
        events: [
          userEvent('看下 https://devops.ronhan.com/#demand/RO-20261027-008'),
          headerEvent({ provider: 'p', model: 'm' }),
        ],
        config: { prefixDevops: { get: () => true } },
        services: { sessionTitle: { config: { maxTitleBytes: 240 } } },
        llm: {
          stream: async function* () {
            yield { type: 'text-delta', index: 0, text: 'RO-20261027-008 收银台支付结果倒计时不跳转修复｜修复倒计时跳转' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        },
      })

      const body = await (await handler(post({ sessionId: 'session-1' }))).json()

      assert.deepEqual(body, {
        ok: true,
        title: 'RO-20261027-008 收银台支付结果倒计时不跳转修复｜修复倒计时跳转',
      })
    })
  })
})

test('route ignores devops links that only appear in tool output', async () => {
  const { handler } = harness({
    events: [
      userEvent('看下这个任务'),
      {
        type: 'tool/result',
        seq: nextSeq++,
        time: 0,
        data: { message: { id: 'tool-1', role: 'tool', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'https://devops.ronhan.com/#demand/RO-20261027-008' }] } },
        surfaceOp: 'append',
      },
      headerEvent({ provider: 'p', model: 'm' }),
    ],
    config: { prefixDevops: { get: () => true } },
    services: { sessionTitle: { config: { maxTitleBytes: 240 } } },
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '修复倒计时跳转' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })

  const body = await (await handler(post({ sessionId: 'session-1' }))).json()

  assert.deepEqual(body, { ok: true, title: '修复倒计时跳转' })
})

test('route never falls back to another model when the Session route fails', async () => {
  let calls = 0
  const { handler } = harness({
    llm: {
      prepareCall: async () => {
        calls += 1
        throw new Error('no adapter registered for this route')
      },
    },
  })

  const body = await (await handler(post({ sessionId: 'session-1' }))).json()

  assert.equal(calls, 1, 'the Session route is tried exactly once')
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'model-error')
})
