/**
 * Host half of `@local/session-rename`.
 *
 * Reads one Session's conversation through the official cold-capable query
 * service, asks the Session's own model for a one-line title, and accepts that
 * title through the session controller, which resumes a cold Session on demand.
 * The sidebar rows this serves are usually not live, so neither path may depend
 * on `ctx.sessions.get()` returning a loaded Session.
 */

import z from '@deepseek-ai/schemastery'

import { findDevopsRefs } from './lib/devops/devops-refs.mjs'
import { resolveFirstDevopsTitle } from './lib/devops/devops-resolve.mjs'
import { describeCredentials, loadDevopsCredentials } from './lib/devops/devops-credentials.mjs'
import { composeDevopsTitle, DEVOPS_SUMMARY_PROMPT } from './lib/title.mjs'

/** Cordis plugin name. */
export const name = 'session-rename'

/** Host services the route needs; without them the plugin does not activate. */
export const inject = ['connection', 'sessionQuery', 'sessionController', 'llm']

/**
 * Profile settings. Only `.volatile()` fields appear on the bundle's page in
 * the Plugins manager, and saving one updates the Loader ref in place, so the
 * route must read the field on every request instead of caching a boolean.
 */
export const Config = z.object({
  /** Prefix generated titles with the devops record number/title. Off by default. */
  prefixDevops: z.boolean().default(false).volatile(),
})

/** The one route the browser half calls. */
export const ROUTE = '/api/session-rename'

/** Read-only status route the bundle's configuration page calls. */
export const STATUS_ROUTE = '/api/session-rename/devops-status'

/** Input budget for the summarized transcript, in UTF-8 bytes. */
const DEFAULT_MAX_BYTES = 8192

/** Trailing messages kept from a long conversation. */
const RECENT_MESSAGES = 8

/**
 * Ceiling against runaway output, not a length target: a title is a few tokens,
 * but reasoning a model cannot switch off also counts as output, so a tight cap
 * would end the call as `max-tokens` on such models.
 */
const MAX_OUTPUT_TOKENS = 4096
const TIMEOUT_MS = 30_000

/** Fallback title byte cap; the live title service's own budget wins when readable. */
const TITLE_MAX_BYTES = 200

/**
 * The system instruction for the auxiliary title request. The model sees a JSON
 * body of `{ currentTitle, messages }` and must answer with the title alone.
 */
export const TITLE_SYSTEM_PROMPT = [
  'Read the conversation between the human user and the assistant, then write one title that names the task this session ended up doing or producing.',
  'Focus on the final task and its outcome, not on the opening greeting or small talk.',
  'Return only the title itself on a single line: no quotes, no numbering, no prefix, no explanation, no Markdown, no line breaks.',
  'Use the language of the conversation.',
  'Aim for about 20 CJK characters, or about 8 words in other languages.',
  'If the conversation is too sparse to name a task, return the shortest reasonable title instead of explaining.',
].join('\n')

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** UTF-8 size of one string. */
function utf8Bytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** Cut one string to a UTF-8 byte budget without splitting a code point. */
function truncateUtf8(text, maxBytes) {
  if (utf8Bytes(text) <= maxBytes) return text
  let used = 0
  let output = ''
  for (const character of text) {
    const size = utf8Bytes(character)
    if (used + size > maxBytes) break
    output += character
    used += size
  }
  return output
}

/** Fall back to a positive default for an untrusted numeric option. */
function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** Control characters that never belong in a title (C0/C1 plus bidi controls). */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

/** Whole-line quote pairs a model may wrap the title in. */
const QUOTE_WRAPPERS = [
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
  ['\u300c', '\u300d'],
  ['\u300e', '\u300f'],
  ['\u300a', '\u300b'],
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
]

/** A bullet, numbered, heading or blockquote prefix a model may put before the title. */
const LIST_PREFIX = /^(?:#{1,6}\s+|>\s+|[-*+\u2022]\s+|\d{1,3}[.)]\s+)/u

/** A leading `Title:` / `标题：` label a model may put before the title. */
const TITLE_PREFIX = /^(?:title|标题)\s*[:：]\s*/iu

/** A Markdown code-fence marker: never a title line. */
const CODE_FENCE = /^(?:```|~~~)/u

/** A title must carry at least one letter, digit or CJK character. */
const VISIBLE_TITLE_CHARACTER = /[\p{L}\p{N}]/u

/** Whole-line asterisk or underscore emphasis, such as `**Title**`. */
const EMPHASIS_WRAPPER = /^(\*{1,3}|_{1,3})(\S(?:[\s\S]*\S)?)\1$/u

/** Strip one whole-line wrapper, or return null when the line has none. */
function stripWrapper(line) {
  for (const [open, close] of QUOTE_WRAPPERS) {
    if (line.length > open.length + close.length && line.startsWith(open) && line.endsWith(close)) {
      return line.slice(open.length, line.length - close.length).trim()
    }
  }
  const emphasis = EMPHASIS_WRAPPER.exec(line)
  if (emphasis !== null && !emphasis[2].includes(emphasis[1])) return emphasis[2].trim()
  return null
}

/** Text of one message content value: text blocks only, joined per block. */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Clean one model answer into a title: the first non-empty line, without any
 * whole-line quote, emphasis or list wrapper, without control characters, with
 * whitespace collapsed and the byte budget enforced.
 * @param {unknown} raw - raw model text.
 * @param {number} [maxBytes] - UTF-8 byte cap of the returned title.
 * @returns {string} the clean title, or an empty string when nothing usable remains.
 */
export function cleanTitle(raw, maxBytes = TITLE_MAX_BYTES) {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  let line = ''
  for (const candidate of raw.split(/\r\n|\r|\n/u)) {
    const text = candidate.replace(CONTROL_CHARACTERS, '').trim()
    // A fence or a table rule is never the title line: keep looking.
    if (text.length > 0 && !CODE_FENCE.test(text) && !/^\|?[\s:|-]+\|?$/u.test(text)) {
      line = text
      break
    }
  }
  if (line.length === 0) return ''

  let title = line
  for (let guard = 0; guard < 6; guard += 1) {
    const withoutPrefix = title.replace(TITLE_PREFIX, '').replace(LIST_PREFIX, '').trim()
    if (withoutPrefix !== title) {
      title = withoutPrefix
      continue
    }
    const stripped = stripWrapper(title)
    if (stripped === null) break
    title = stripped
    if (title.length === 0) break
  }

  title = title.replace(/\s+/gu, ' ').trim()
  // A code fence, bare punctuation or an empty emphasis wrapper is not a title.
  if (CODE_FENCE.test(title) || !VISIBLE_TITLE_CHARACTER.test(title)) return ''
  return truncateUtf8(title, maxBytes).trimEnd()
}

/** Extract the human and assistant text entries of one Session event log. */
function transcriptEntries(events) {
  const entries = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    // Replacement surface nodes are model-only: a landed replacement would
    // erase conversation the human already saw, so the transcript is append-only.
    if (event.surfaceOp !== 'append') continue
    if (event.type === 'user/message') {
      const data = event.data
      if (data === null || typeof data !== 'object') continue
      // Only human input, never injected context or plugin-authored messages.
      if (data.source?.kind !== 'user') continue
      const text = textOfContent(data.content).trim()
      if (text.length > 0) entries.push({ role: 'user', text })
      continue
    }
    if (event.type === 'assistant/message') {
      const message = event.data?.message
      if (message === null || typeof message !== 'object') continue
      const text = textOfContent(message.content).trim()
      if (text.length > 0) entries.push({ role: 'assistant', text })
    }
  }
  return entries
}

/**
 * Select the conversation text sent to the model: the first human message plus
 * the latest messages, within one UTF-8 byte budget. The first human message is
 * never dropped, but it may take at most a fixed share of the budget while
 * recent messages exist — a pasted 20 KB opening must not starve the latest
 * context, which is what names the task the Session ended up doing.
 * @param {unknown} events - Session events from a session-query observation.
 * @param {{ maxBytes?: number, recent?: number }} [options] - budget and trailing window.
 * @returns {{ messages: Array<{ role: 'user' | 'assistant', text: string }>, truncated: boolean }}
 */
export function buildTranscript(events, options = {}) {
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES)
  const recent = positiveInteger(options.recent, RECENT_MESSAGES)
  const all = transcriptEntries(events)
  if (all.length === 0) return { messages: [], truncated: false }

  const firstUserIndex = all.findIndex((entry) => entry.role === 'user')
  const keptIndexes = new Set()
  if (firstUserIndex >= 0) keptIndexes.add(firstUserIndex)
  for (let index = Math.max(0, all.length - recent); index < all.length; index += 1) keptIndexes.add(index)

  const entries = [...keptIndexes].sort((left, right) => left - right).map((index) => ({
    role: all[index].role,
    text: all[index].text,
    pinned: index === firstUserIndex,
  }))
  let truncated = entries.length < all.length

  // Cap the pinned opening only when the kept messages actually exceed the
  // budget, so a conversation that already fits keeps its opening intact.
  const pinned = entries.find((entry) => entry.pinned)
  const recentBytes = entries.reduce((sum, entry) => sum + (entry.pinned ? 0 : utf8Bytes(entry.text)), 0)
  if (pinned !== undefined && utf8Bytes(pinned.text) + recentBytes > maxBytes) {
    const pinnedBudget = recentBytes > 0 ? Math.max(256, Math.floor(maxBytes * 0.4)) : maxBytes
    if (utf8Bytes(pinned.text) > pinnedBudget) {
      pinned.text = truncateUtf8(pinned.text, pinnedBudget).trimEnd()
      truncated = true
    }
  }

  let total = entries.reduce((sum, entry) => sum + utf8Bytes(entry.text), 0)

  // Drop the oldest kept recent entries first, so the newest context survives.
  while (total > maxBytes) {
    const droppable = entries.findIndex((entry) => !entry.pinned)
    if (droppable < 0) break
    total -= utf8Bytes(entries[droppable].text)
    entries.splice(droppable, 1)
    truncated = true
  }

  const onlyPinned = entries.find((entry) => entry.pinned)
  if (onlyPinned !== undefined && total > maxBytes) {
    onlyPinned.text = truncateUtf8(onlyPinned.text, maxBytes).trimEnd()
    truncated = true
  }

  return { messages: entries.map(({ role, text }) => ({ role, text })), truncated }
}

/** The model route recorded by the latest `request/header` event, if any. */
function routeFromEvents(events) {
  let header
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'request/header') header = event.data?.header
  }
  const config = header?.config
  if (config === null || typeof config !== 'object') return undefined
  const { provider, model } = config
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/** The latest accepted Session title in the log, or null before the first one. */
function currentTitleFromEvents(events) {
  let title = null
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  if (title === null) return null
  const trimmed = title.trim()
  return trimmed.length === 0 ? null : trimmed
}

// ---------------------------------------------------------------------------
// Session reading
// ---------------------------------------------------------------------------

/**
 * Read everything the title request needs from one observation, then release
 * the lease. Works for live and cold (prepared) Sessions alike.
 * @param {object} ctx - Host context carrying `sessionQuery`.
 * @param {string} sessionId - Session to read.
 * @param {AbortSignal} signal - caller cancellation plus the request deadline.
 * @param {boolean} [scanDevops] - whether to collect text for devops link discovery.
 * @returns {Promise<{ transcript: object, route: object | undefined, currentTitle: string | null, devopsText: string }>}
 */
async function readSessionInputs(ctx, sessionId, signal, scanDevops = true) {
  const observation = await ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })
  try {
    const events = observation.events
    return {
      transcript: buildTranscript(events),
      route: routeFromEvents(events),
      currentTitle: currentTitleFromEvents(events),
      devopsText: scanDevops ? collectDevopsText(events) : '',
    }
  } finally {
    observation?.[Symbol.dispose]?.()
  }
}

/** Text of one event's message content, for devops link discovery. */
function eventTextForDevops(event) {
  if (event === null || typeof event !== 'object') return ''
  // Replacement surface nodes are model-only and never part of the human transcript.
  if (event.surfaceOp !== 'append') return ''
  if (event.type === 'user/message') {
    const data = event.data
    if (data === null || typeof data !== 'object') return ''
    if (data.source?.kind !== 'user') return ''
    return textOfContent(data.content)
  }
  if (event.type === 'assistant/message') return textOfContent(event.data?.message?.content)
  return ''
}

/**
 * Collect the conversations text a devops link can hide in, capped so a huge
 * tool output cannot make one click expensive. The transcript sent to the model
 * keeps only the first and latest messages, so link discovery reads the log.
 * @param {unknown} events - Session events from a session-query observation.
 * @param {number} [maxBytes] - UTF-8 cap across all collected text.
 * @returns {string} the collected text, in log order.
 */
function collectDevopsText(events, maxBytes = 512 * 1024) {
  const parts = []
  let used = 0
  for (const event of Array.isArray(events) ? events : []) {
    const text = eventTextForDevops(event)
    if (text.length === 0) continue
    const size = utf8Bytes(text)
    if (used + size > maxBytes) {
      const room = maxBytes - used
      if (room > 0) parts.push(truncateUtf8(text, room))
      break
    }
    parts.push(text)
    used += size
  }
  return parts.join('\n')
}

/**
 * Resolve the Session's primary devops record for a title prefix, or null.
 * Every failure — no link, no credential, platform error — means "no prefix".
 * @param {string} text - collected conversation text.
 * @returns {Promise<{ number: string, title: string } | null>} the record, or null.
 */
async function resolveSessionDevops(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  try {
    const refs = findDevopsRefs(text)
    if (refs.length === 0) return null
    const credentials = loadDevopsCredentials()
    if (credentials.token.length === 0) return null
    // The first resolvable reference wins; try a few so an unreadable link
    // (a deleted record, a numeric defect id) does not drop a readable one.
    return await resolveFirstDevopsTitle(refs, credentials, undefined, { limit: 3, timeoutMs: 2500 })
  } catch {
    return null
  }
}

/**
 * Remove a repeated devops prefix from the model summary: a model that ignored
 * the instruction must not produce `number title｜number title…`.
 * @param {string} text - the cleaned model answer.
 * @param {{ number: string, title: string }} devops - the resolved record.
 * @returns {string} the summary without a repeated prefix.
 */
function stripRepeatedDevopsPrefix(text, devops) {
  let rest = text
  const prefix = `${devops.number} ${devops.title}`.trim()
  for (const part of [prefix, devops.title, devops.number]) {
    if (part.length > 0 && rest.startsWith(part)) rest = rest.slice(part.length)
  }
  return rest.replace(/^[\s｜|:：\-]+/u, '').trim()
}

// ---------------------------------------------------------------------------
// Title generation
// ---------------------------------------------------------------------------

/** One coded, user-readable failure: the wire shape shared with the browser half. */
function failure(code, message) {
  return { kind: 'failure', code, message }
}

/** Map one terminal non-stop finish reason onto a coded failure. */
function failureFromFinish(finish, timeoutSignal) {
  const kind = finish?.kind
  if (kind === 'aborted') {
    return timeoutSignal.aborted
      ? failure('timeout', '总结超时（30 秒），请稍后再试')
      : failure('cancelled', '总结已取消，请重试')
  }
  if (kind === 'max-tokens') return failure('model-error', '模型输出被截断，请重试')
  if (kind === 'tool-calls') return failure('model-error', '模型返回了工具调用而不是标题，请重试')
  const detail = finish?.failure?.message
  if (typeof detail !== 'string' || detail.length === 0) return failure('model-error', '模型调用失败，请重试')
  return failure('model-error', `模型调用失败：${truncateUtf8(detail, 160)}`)
}

/**
 * Open one auxiliary title stream on the Session's own route. When the runtime
 * offers `prepareCall` (every current deployment does), select the model's
 * least supported reasoning effort: title wording never needs deep reasoning,
 * and unselected effort would spend the output budget on hidden tokens and end
 * the call as `max-tokens`. The plain `stream` path is the fallback for older
 * runtimes and test doubles.
 * @param {object} ctx - Host context carrying `llm`.
 * @param {{ provider: string, model: string }} route - route from the latest header.
 * @param {string} sessionId - Session that owns the auxiliary request record.
 * @param {string} payload - JSON body of the title request.
 * @param {AbortSignal} signal - caller cancellation plus the request deadline.
 * @param {string} [system] - system instruction for the auxiliary request.
 * @returns {Promise<AsyncIterable<object>>} the raw chunk stream.
 */
async function openTitleStream(ctx, route, sessionId, payload, signal, system = TITLE_SYSTEM_PROMPT) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: payload }] }]
  const base = { provider: route.provider, model: route.model, maxTokens: MAX_OUTPUT_TOKENS }
  if (typeof ctx.llm.prepareCall === 'function') {
    const prepared = await ctx.llm.prepareCall(base, signal, (controls, model) => {
      const effort = model?.reasoning?.efforts?.[0]?.id
      return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
    })
    return prepared.stream({
      ...prepared.config,
      messages,
      system,
      sessionId,
      purpose: 'session-rename',
      signal,
    })
  }
  return ctx.llm.stream({
    ...base,
    messages,
    system,
    sessionId,
    purpose: 'session-rename',
    signal,
  })
}

/** The live title service's accepted-title byte budget, when readable. */
function titleByteBudget(ctx) {
  const config = typeof ctx.get === 'function' ? ctx.get('sessionTitle')?.config : undefined
  const value = config?.maxTitleBytes
  return Number.isInteger(value) && value > 0 ? value : TITLE_MAX_BYTES
}

/** Read one config field, tolerating the Loader's volatile ref wrapper. */
function readConfigField(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/** Whether generated titles should carry the devops prefix (read per request). */
export function devopsPrefixEnabled(config) {
  return readConfigField(config?.prefixDevops, false) === true
}

/**
 * Ask the Session's own model for one title.
 * @param {object} ctx - Host context carrying `llm`.
 * @param {string} sessionId - Session that owns the auxiliary request log record.
 * The route comes from the Session's own last request header. A failed call is
 * reported as a coded failure and is never retried on a default or official
 * model: this feature must not silently rename a Session with a model the user
 * did not run it on.
 * @param {object} inputs - transcript, route and current title read from the log.
 * @param {AbortSignal} signal - caller cancellation plus the request deadline.
 * @param {AbortSignal} timeoutSignal - the deadline alone, to tell timeouts from cancellation.
 * @returns {Promise<{ kind: 'title', title: string } | { kind: 'failure', code: string, message: string }>}
 */
async function generateTitle(ctx, sessionId, inputs, signal, timeoutSignal, devops = null) {
  const payload = JSON.stringify({
    ...(devops === null ? { currentTitle: inputs.currentTitle } : {}),
    messages: inputs.transcript.messages,
    ...(devops === null ? {} : { devops: { number: devops.number, title: devops.title } }),
  })
  const system = devops === null ? TITLE_SYSTEM_PROMPT : DEVOPS_SUMMARY_PROMPT

  let text = ''
  let finish
  try {
    const stream = await openTitleStream(ctx, inputs.route, sessionId, payload, signal, system)
    for await (const chunk of stream) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        continue
      }
      if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (error) {
    if (signal.aborted) return failureFromFinish({ kind: 'aborted' }, timeoutSignal)
    const detail = error instanceof Error ? error.message : String(error)
    return failure('model-error', `模型调用失败：${truncateUtf8(detail, 160)}`)
  }

  if (finish === undefined) return failure('model-error', '模型没有返回结束标记，请重试')
  if (finish.kind !== 'stop') return failureFromFinish(finish, timeoutSignal)

  const titleBudget = titleByteBudget(ctx)
  const cleaned = cleanTitle(text, titleBudget)
  if (devops !== null) {
    // The prefix is meaningful even when the model returned nothing usable.
    const composed = composeDevopsTitle({
      number: devops.number,
      platformTitle: devops.title,
      summary: stripRepeatedDevopsPrefix(cleaned, devops),
      maxBytes: titleBudget,
    })
    if (composed.length === 0) return failure('empty-title', '模型没有输出可用的标题，请重试')
    return { kind: 'title', title: composed }
  }
  if (cleaned.length === 0) return failure('empty-title', '模型没有输出可用的标题，请重试')
  return { kind: 'title', title: cleaned }
}

// ---------------------------------------------------------------------------
// Title acceptance
// ---------------------------------------------------------------------------

/** Accept one title through the session controller, falling back to a live Session. */
async function acceptTitle(ctx, sessionId, title) {
  const controller = ctx.sessionController
  if (controller !== undefined && typeof controller.rename === 'function') {
    try {
      const accepted = await controller.rename({ sessionId, title })
      return {
        kind: 'title',
        title: typeof accepted?.title === 'string' && accepted.title.length > 0 ? accepted.title : title,
      }
    } catch (error) {
      const code = error?.code
      if (code === 'session/not-found') return failure('session-missing', '找不到这个会话：它可能已经被删除，刷新页面后再试')
      if (code === 'session/title-invalid') return failure('empty-title', '生成的标题没有可用的内容，请重试')
      if (code === 'session/agent-busy') return failure('unavailable', '这个会话由子智能体管理，暂时无法重命名')
      if (code === 'session/writer-held') return failure('locked', '这个会话正被另一处占用，暂时无法重命名')
      throw error
    }
  }
  return acceptTitleOnLiveSession(ctx, sessionId, title)
}

/** Defensive path for deployments without a session controller: live Sessions only. */
function acceptTitleOnLiveSession(ctx, sessionId, title) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  const sessionTitle = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
  const session = sessions?.get?.(sessionId)
  if (session === undefined) return failure('session-missing', '找不到这个会话：它可能已经结束，刷新页面后再试')
  if (typeof sessionTitle?.rename !== 'function') throw new Error('session-rename: no session-title service is mounted')
  try {
    const accepted = sessionTitle.rename(session, title)
    return {
      kind: 'title',
      title: typeof accepted?.title === 'string' && accepted.title.length > 0 ? accepted.title : title,
    }
  } catch (error) {
    if (error?.name === 'SessionTitleInvalidError') return failure('empty-title', '生成的标题没有可用的内容，请重试')
    throw error
  }
}

// ---------------------------------------------------------------------------
// HTTP route
// ---------------------------------------------------------------------------

/** One JSON response with no caching of any kind. */
function jsonResponse(body) {
  return Response.json(body, { headers: { 'cache-control': 'no-store' } })
}

/** One coded failure, delivered with HTTP 200 so the browser can show its reason. */
function failureResponse(code, message) {
  return jsonResponse({ ok: false, error: { code, message } })
}

/** One plain-text response for protocol or unexpected failures. */
function plainResponse(text, status) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Read the request body as one JSON object, or undefined when it is not one. */
async function readPayload(request) {
  let payload
  try {
    payload = await request.json()
  } catch {
    return undefined
  }
  return payload !== null && typeof payload === 'object' ? payload : undefined
}

/** One summarize-and-rename in progress per Session id, across requests and tabs. */
const inFlight = new Map()

/** Run one summarize-and-rename for a Session id that already passed validation. */
async function summarizeSession(ctx, config, sessionId, request) {
  const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS)
  const callerSignal = request.signal
  const signal = callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal])

  let inputs
  try {
    inputs = await readSessionInputs(ctx, sessionId, signal, devopsPrefixEnabled(config))
  } catch (error) {
    if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return failureResponse('session-missing', '找不到这个会话：它可能已经被删除，刷新页面后再试')
    if (error?.code === 'SESSION_QUERY_ABORTED') {
      return timeoutSignal.aborted
        ? failureResponse('timeout', '读取会话超时，请重试')
        : failureResponse('cancelled', '总结已取消，请重试')
    }
    throw error
  }

  if (!inputs.transcript.messages.some((message) => message.role === 'user')) {
    return failureResponse('no-messages', '这个会话还没有用户消息，暂时无法总结')
  }
  if (inputs.route === undefined) {
    return failureResponse('no-route', '这个会话还没有可用的模型路由，先发一条消息再试')
  }

  const prefixDevops = devopsPrefixEnabled(config)
  const devops = prefixDevops ? await resolveSessionDevops(inputs.devopsText) : null
  const generated = await generateTitle(ctx, sessionId, inputs, signal, timeoutSignal, devops)
  if (generated.kind === 'failure') return failureResponse(generated.code, generated.message)

  const accepted = await acceptTitle(ctx, sessionId, generated.title)
  if (accepted.kind === 'failure') return failureResponse(accepted.code, accepted.message)
  return jsonResponse({ ok: true, title: accepted.title })
}

/** Serve one summarize-and-rename request; expected failures stay on HTTP 200. */
async function serveRequest(ctx, config, request) {
  const payload = await readPayload(request)
  if (payload === undefined) return plainResponse('the request body must be JSON', 400)
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return plainResponse('the request body must name one sessionId', 400)
  }

  // The row button guards against a second click, but another tab, a reload or a
  // remounted row bypasses it: one Session must never pay for two model calls.
  if (inFlight.has(sessionId)) {
    return failureResponse('busy', '这个会话正在总结中，请稍候再试')
  }
  const task = summarizeSession(ctx, config, sessionId, request)
  inFlight.set(sessionId, task)
  try {
    return await task
  } finally {
    inFlight.delete(sessionId)
  }
}

/** Handle the route: protocol failures answer plainly, expected failures code, anything else is a 500. */
async function handleRequest(ctx, config, request) {
  try {
    return await serveRequest(ctx, config, request)
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    ctx.logger?.warn?.(`session-rename: summarize and rename failed: ${detail}`)
    return plainResponse('the session-rename route failed unexpectedly', 500)
  }
}

/**
 * Register the Host route.
 * @param {object} ctx - Host context carrying the injected services.
 * @returns {void}
 */
export function apply(ctx, config) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleRequest(ctx, config, request),
  }), 'session-rename: summarize route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: STATUS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => statusResponse(ctx, config),
  }), 'session-rename: status route')
}

/**
 * Answer the bundle configuration page: the switch, whether a devops
 * credential is readable (never the token), and the live title budget.
 * @param {object} ctx - Host context carrying `sessionTitle`.
 * @param {unknown} config - the plugin configuration ref.
 * @returns {Response} JSON status.
 */
function statusResponse(ctx, config) {
  try {
    const credentials = describeCredentials(loadDevopsCredentials())
    return jsonResponse({
      ok: true,
      prefixDevops: devopsPrefixEnabled(config),
      devops: {
        hasToken: credentials.hasToken,
        source: credentials.source,
        baseUrl: credentials.baseUrl,
      },
      titleBudget: titleByteBudget(ctx),
    })
  } catch (error) {
    ctx.logger?.warn?.(`session-rename: devops status failed: ${error instanceof Error ? error.message : String(error)}`)
    return jsonResponse({ ok: false })
  }
}
