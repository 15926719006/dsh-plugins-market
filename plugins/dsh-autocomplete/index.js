/**
 * Host half of `@local/dsh-autocomplete`.
 *
 * The Codex desktop app predicts the user's next message after every turn and
 * offers it as ghost text in the composer. This plugin rebuilds that behaviour
 * on DeepSeek Harness:
 *
 * - it folds `session/event` into a small rolling transcript per session
 *   (recent human prompts, recent assistant answers, the tools the agent ran,
 *   and the exact provider/model route the session used);
 * - when one turn of a top-level session ends it asks that same route once,
 *   through `ctx.llm`, for the sentence the user is likely to type next,
 *   constrained to `{ "suggestion": string|null }` so the model can abstain
 *   instead of guessing;
 * - it serves the answer to the browser half over
 *   `GET /plugins/autocomplete/state`, which the browser turns into an
 *   inline hint accepted with Tab.
 *
 * Opening an older conversation asks for a prediction on demand (`catch_up`),
 * so switching sessions refreshes the hint instead of leaving it stale.
 *
 * Nothing is appended to the session log: the prediction is a derived cache,
 * exactly like a replayed projection value. Dropping it loses nothing, and a
 * Host restart simply predicts again after the next turn.
 *
 * @module @local/dsh-autocomplete
 */

/** Cordis plugin name. */
export const name = 'autocomplete'

/** The browser carrier is the only Host service this row strictly needs. */
export const inject = ['webServer']

/** State route the browser half polls. */
export const STATE_PATH = '/plugins/autocomplete/state'

/** Diagnostics route, so the wiring can be checked from the outside. */
export const DEBUG_PATH = '/plugins/autocomplete/debug'

/** Dry-run route: predicts from a caller-supplied transcript, for verification. */
export const PREDICT_PATH = '/plugins/autocomplete/predict'

/** Verification route: seeds one session's state without a model call. */
export const SEED_PATH = '/plugins/autocomplete/seed'

/** Diagnostic route: records what a tap or Tab actually did in the page. */
export const TAP_PATH = '/plugins/autocomplete/tap'

/** Verification route: simulates a turn boundary so the suppression can be tested. */
export const SIMULATE_PATH = '/plugins/autocomplete/simulate'

/** How long to wait after `turn/end` before spending a model call. */
const DELAY_MS = 700

/** Give up on one prediction after this long. */
const TIMEOUT_MS = 30_000

/** Output cap: one sentence, and `null` is a legitimate answer. */
const MAX_TOKENS = 400

/** Recent human prompts kept in the transcript. */
const MAX_USER_TURNS = 4

/** Recent assistant answers kept in the transcript. */
const MAX_ASSISTANT_TURNS = 4

/** Tool calls kept, as bare names. */
const MAX_TOOL_NAMES = 24

/** Longest excerpt kept per message. */
const MAX_EXCERPT = 1_200

/** Instruction sent as the system prompt; the shape mirrors Codex's own. */
const INSTRUCTION = [
  'You predict the single next message the human user will type in this coding-assistant session.',
  'Read the transcript of the turn that just ended, including the tools the assistant ran.',
  'Return one short, concrete, actionable sentence in the user\'s language, phrased as the user would type it.',
  'Prefer a next step that follows directly from what the assistant just did or just left undone.',
  'Never describe the assistant in the third person, never explain yourself, never use Markdown, and never mention the transcript.',
  'Answer with exactly one JSON object and nothing else: {"suggestion": "<the sentence>"} — or {"suggestion": null} when you must abstain.',
  'The user is mid-work and wants to keep going, so a concrete next step usually exists: a file to inspect, a step to verify, a decision to confirm, or the next piece of the same task.',
  'Return a sentence unless the transcript truly has nothing to continue — no assistant answer at all, or nothing but a greeting or a thank-you.',
].join('\n')

/** Response schema appended verbatim, as Codex does. */
const SCHEMA = {
  type: 'object',
  properties: { suggestion: { type: ['string', 'null'] } },
  required: ['suggestion'],
  additionalProperties: false,
}

/**
 * Join the text blocks of one message into one string.
 * @param message - a user or assistant message, or anything shaped like one.
 * @returns the joined text, empty when the message carries none.
 */
export function textOfMessage(message) {
  const content = message !== null && typeof message === 'object' ? message.content : undefined
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') continue
    parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Read one event payload's message text.
 *
 * A `user/message` payload carries `content` directly (the message plus its
 * `source`), while `assistant/message` nests it under `message`.
 * @param data - the event's `data` object.
 * @returns the joined text, empty when the payload carries none.
 */
export function textOfEvent(data) {
  if (data === null || typeof data !== 'object') return ''
  const nested = data.message !== null && typeof data.message === 'object' ? data.message : undefined
  if (nested !== undefined && Array.isArray(nested.content)) return textOfMessage(nested)
  return textOfMessage(data)
}

/**
 * Collapse whitespace and cut one excerpt.
 * @param text - the raw text.
 * @param max - maximum characters.
 * @returns the collapsed excerpt.
 */
export function clip(text, max = MAX_EXCERPT) {
  const flat = String(text === null || text === undefined ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Does this session belong to work the user drives directly?
 * @param session - the live Session.
 * @returns false for subagent sessions.
 */
export function isUserSession(session) {
  const header = session !== null && typeof session === 'object' ? session.header : undefined
  if (header === null || typeof header !== 'object') return true
  if (header.origin === 'subagent') return false
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
  return true
}

/**
 * Pull the provider/model route out of one `request/header` payload.
 * @param event - a `request/header` session event.
 * @returns `{ provider, model }`, or undefined when the payload is unrecognized.
 */
export function routeOfHeaderEvent(event) {
  const header = event !== null && typeof event === 'object' ? event.data?.header : undefined
  return routeOfHeader(header)
}

/**
 * Pull the provider/model route out of one epoch header object.
 * @param header - an `EpochHeader`, or anything shaped like one.
 * @returns `{ provider, model }`, or undefined when the payload is unrecognized.
 */
export function routeOfHeader(header) {
  if (header === null || typeof header !== 'object') return undefined
  const route = header.route !== null && typeof header.route === 'object' ? header.route : header
  const provider = typeof route.provider === 'string' ? route.provider : undefined
  const model = typeof route.model === 'string' ? route.model : undefined
  return provider !== undefined && model !== undefined ? { provider, model } : undefined
}

/**
 * Fold committed session events into one rolling record, applying the same
 * rules as the live observer: human prompts only, assistant answers, tool names.
 * @param events - committed session events, oldest first.
 * @returns `{ users, assistants, tools }`.
 */
export function foldEvents(events) {
  const record = { users: [], assistants: [], tools: [], route: undefined }
  const list = Array.isArray(events) ? events : []
  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    if (event.type === 'request/header') {
      const route = routeOfHeaderEvent(event)
      if (route !== undefined) record.route = route
      continue
    }
    if (event.type === 'user/message') {
      const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
      // Injected context is not something the human typed.
      if (source.kind !== undefined && source.kind !== 'user') continue
      const text = textOfEvent(data)
      if (text.length === 0) continue
      record.users.push(text)
      if (record.users.length > MAX_USER_TURNS) record.users.shift()
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOfEvent(data)
      if (text.length === 0) continue
      record.assistants.push(text)
      if (record.assistants.length > MAX_ASSISTANT_TURNS) record.assistants.shift()
      continue
    }
    if (event.type === 'tool/call') {
      const toolName = typeof data.name === 'string' ? data.name : ''
      if (toolName.length === 0) continue
      record.tools.push(toolName)
      if (record.tools.length > MAX_TOOL_NAMES) record.tools.shift()
    }
  }
  return record
}

/**
 * Render one rolling record as the transcript handed to the model.
 * @param record - `{ users, assistants, tools }` collected from events.
 * @returns the transcript text.
 */
export function transcriptOfRecord(record) {
  const users = Array.isArray(record?.users) ? record.users : []
  const assistants = Array.isArray(record?.assistants) ? record.assistants : []
  const tools = Array.isArray(record?.tools) ? record.tools : []
  const lines = []
  const pairs = Math.max(users.length, assistants.length)
  for (let index = 0; index < pairs; index += 1) {
    const user = users[index]
    const assistant = assistants[index]
    if (user !== undefined) lines.push(`USER: ${clip(user)}`)
    if (assistant !== undefined) lines.push(`ASSISTANT: ${clip(assistant)}`)
  }
  if (tools.length > 0) lines.push(`TOOLS USED: ${tools.slice(-MAX_TOOL_NAMES).join(', ')}`)
  return lines.join('\n\n')
}

/**
 * Build the same compact transcript from a session's derived model messages.
 * @param messages - `session.deriveMessages()` output.
 * @returns `{ transcript, users, assistants }`.
 */
export function transcriptOfMessages(messages) {
  const users = []
  const assistants = []
  const list = Array.isArray(messages) ? messages : []
  for (const message of list) {
    if (message === null || typeof message !== 'object') continue
    const text = textOfMessage(message)
    if (text.length === 0) continue
    if (message.role === 'user') users.push(text)
    else if (message.role === 'assistant') assistants.push(text)
  }
  return {
    transcript: transcriptOfRecord({
      users: users.slice(-MAX_USER_TURNS),
      assistants: assistants.slice(-MAX_ASSISTANT_TURNS),
      tools: [],
    }),
    users: users.length,
    assistants: assistants.length,
  }
}

/**
 * Collect a streamed answer chunk, tolerating the adapter's chunk vocabulary.
 * @param chunk - one streamed chunk.
 * @param sink - accumulator receiving text deltas.
 */
export function collectChunk(chunk, sink) {
  if (chunk === null || typeof chunk !== 'object') return
  const type = typeof chunk.type === 'string' ? chunk.type : ''
  if (type === 'text-delta') {
    const text = typeof chunk.text === 'string' ? chunk.text : typeof chunk.delta === 'string' ? chunk.delta : undefined
    if (text !== undefined) sink.push(text)
    return
  }
  if (type === 'text' && typeof chunk.text === 'string') sink.push(chunk.text)
}

/**
 * Read `suggestion` out of the model's JSON answer.
 * @param raw - the accumulated answer text.
 * @returns the suggestion, or null when the model abstained or broke the schema.
 */
export function suggestionOf(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim()
  if (text.length === 0) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    let parsed
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
      parsed = undefined
    }
    if (parsed !== null && typeof parsed === 'object') {
      const value = parsed.suggestion
      if (typeof value !== 'string') return null
      const trimmed = value.trim()
      return trimmed.length === 0 ? null : trimmed
    }
  }
  // A model that ignores the JSON shape still carries the sentence: keep it when
  // it is short and plainly not a refusal.
  const plain = text
    .replace(/^```[a-z]*\s*/iu, '')
    .replace(/```$/u, '')
    .replace(/^suggestion\s*[:：]\s*/iu, '')
    .replace(/^["'“”](?<inner>[\s\S]*)["'“”]$/u, '$<inner>')
    .trim()
  if (plain.length === 0 || plain.length > 400) return null
  if (/^(null|none|n\/a)$/iu.test(plain)) return null
  if (/\n/u.test(plain)) return null
  return plain
}

/**
 * Ask the model once for a next-prompt suggestion.
 * @param llm - the Host LLM service.
 * @param route - provider and model to call.
 * @param transcript - the compact transcript.
 * @param signal - cancellation signal.
 * @returns `{ text, raw }`: the suggestion (null when the model abstained) and the
 * exact answer text, kept for diagnostics.
 */
export async function predict(llm, route, transcript, signal) {
  const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: MAX_TOKENS }, signal)
  const options = {
    ...call.config,
    system: INSTRUCTION,
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: `Next-message prediction request.\n\nTranscript:\n${transcript}\n\nReturn only JSON matching this schema: ${JSON.stringify(SCHEMA)}.`,
      }],
    }],
    signal,
  }
  const sink = []
  for await (const chunk of call.stream(options)) {
    if (signal.aborted) break
    collectChunk(chunk, sink)
  }
  const raw = sink.join('')
  return { text: suggestionOf(raw), raw }
}

/**
 * Register the plugin.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx) {
  /** Per-session rolling transcript, folded from the durable event stream. */
  const records = new Map()
  /** Per-session prediction state served to the browser half. */
  const states = new Map()
  /** In-flight generations, so a newer turn can cancel an older one. */
  const inflight = new Map()
  /** Sessions already asked for a catch-up prediction, so polls do not re-spend. */
  const catchUpAsked = new Set()
  /** Sessions with a turn in flight: no hint while the agent is working. */
  const running = new Set()
  /** Pending `turn/end` debounce timers. */
  const timers = new Map()
  /** Diagnostics, readable from the debug route. */
  const stats = {
    observed: 0,
    turnEnds: 0,
    generated: 0,
    catchUps: 0,
    taps: [],
    abstained: 0,
    failed: 0,
    skipped: {},
    lastError: null,
    lastRoute: null,
  }

  /**
   * Record one handled failure.
   * @param where - where it happened.
   * @param error - the thrown value.
   */
  const noteError = (where, error) => {
    const message = error !== null && error !== undefined && error.message !== undefined ? error.message : error
    stats.lastError = `${where}: ${String(message)}`
    ctx.logger.warn(`autocomplete: ${stats.lastError}`)
  }

  /**
   * The deployment default route, used before a session has made a request.
   * @returns `{ provider, model }`, or undefined.
   */
  const defaultRoute = () => {
    const defaults = ctx.get('agentDefaultModel')
    if (defaults === undefined || defaults === null) return undefined
    try {
      const selection = defaults.currentSelection()
      if (selection !== null && typeof selection === 'object'
        && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      // A default-model service that refuses this lookup must not lose the feature.
    }
    return undefined
  }

  /**
   * Write one state record and return it.
   * @param sessionId - the session identity.
   * @param patch - fields to merge.
   * @returns the merged state.
   */
  const setState = (sessionId, patch) => {
    const next = { ...(states.get(sessionId) ?? { sessionId }), ...patch, updatedAt: Date.now() }
    states.set(sessionId, next)
    return next
  }

  /**
   * Ask the model for one next-prompt suggestion.
   * @param sessionId - the session identity.
   */
  const generate = async (sessionId) => {
    inflight.get(sessionId)?.abort()
    const controller = new AbortController()
    inflight.set(sessionId, controller)
    const started = Date.now()
    const record = records.get(sessionId) ?? { users: [], assistants: [], tools: [] }
    const route = record.route ?? defaultRoute()
    stats.lastRoute = route ?? null
    if (route === undefined) {
      stats.failed += 1
      setState(sessionId, { status: 'off', text: null, reason: 'no-model-route' })
      return
    }
    const llm = ctx.get('llm')
    if (llm === undefined || llm === null) {
      stats.failed += 1
      setState(sessionId, { status: 'off', text: null, reason: 'no-llm' })
      return
    }
    const transcript = transcriptOfRecord(record)
    if (transcript.length === 0) {
      setState(sessionId, { status: 'idle', text: null, reason: 'empty-transcript' })
      return
    }
    setState(sessionId, { status: 'pending', text: null, model: `${route.provider}/${route.model}` })
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const signal = controller.signal
      const result = await predict(llm, route, transcript, signal)
      const text = result.text
      if (signal.aborted) return
      stats.generated += 1
      stats.lastRaw = result.raw.slice(0, 300)
      if (text === null) stats.abstained += 1
      setState(sessionId, {
        status: text === null ? 'abstained' : 'ready',
        text,
        transcript,
        ms: Date.now() - started,
      })
    } catch (error) {
      stats.failed += 1
      setState(sessionId, { status: 'error', text: null, reason: String(error) })
      noteError('generate', error)
    } finally {
      clearTimeout(timer)
      if (inflight.get(sessionId) === controller) inflight.delete(sessionId)
    }
  }

  /**
   * Is a turn in flight right now?
   *
   * The live `turn/start` marker covers the normal case, but a plugin reload or
   * a Host restart in the middle of a turn loses it, so the session's own tail of
   * committed events is the tiebreaker.
   * @param sessionId - the session identity.
   * @returns true while the agent is working.
   */
  const isRunningNow = (sessionId) => {
    if (running.has(sessionId)) return true
    const sessions = ctx.get('sessions')
    if (sessions === undefined || sessions === null) return false
    let events = []
    try {
      const session = sessions.get(sessionId)
      events = session?.ownEvents() ?? []
    } catch {
      return false
    }
    const floor = Math.max(0, events.length - 2000)
    for (let index = events.length - 1; index >= floor; index -= 1) {
      const type = events[index]?.type
      if (type === 'turn/end') return false
      if (type === 'turn/start') return true
    }
    return false
  }

  /**
   * Build a transcript from a session's committed log, when the rolling record is
   * empty because the plugin loaded after that conversation ran.
   * @param sessionId - the session identity.
   * @returns `{ transcript, route }`.
   */
  const historyOf = (sessionId) => {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || sessions === null) return undefined
    let session
    try {
      session = sessions.get(sessionId)
    } catch {
      session = undefined
    }
    if (session === undefined || session === null) return undefined
    let events = []
    try {
      // `ownEvents()` holds only what this process appended; a conversation the
      // user opens had its history restored, so read the whole snapshot.
      events = session.snapshotEvents()
    } catch {
      events = []
    }
    if (!Array.isArray(events) || events.length === 0) {
      try {
        events = session.ownEvents()
      } catch {
        events = []
      }
    }
    const folded = foldEvents(events)
    const transcript = transcriptOfRecord(folded)
    if (transcript.length === 0) return undefined
    let route
    try {
      route = routeOfHeader(session.requestHeader())
    } catch {
      route = undefined
    }
    return { transcript, route: folded.route }
  }

  /**
   * Predict once for a conversation the user just opened.
   * @param sessionId - the session identity.
   */
  const catchUp = async (sessionId) => {
    if (running.has(sessionId)) return
    if (catchUpAsked.has(sessionId)) return
    catchUpAsked.add(sessionId)
    const history = historyOf(sessionId)
    const record = records.get(sessionId) ?? { users: [], assistants: [], tools: [] }
    const transcript = history !== undefined && history.transcript.length > 0
      ? history.transcript
      : transcriptOfRecord(record)
    if (transcript.length === 0) {
      setState(sessionId, { status: 'idle', text: null, reason: 'no-history' })
      return
    }
    const route = history?.route ?? record.route ?? defaultRoute()
    const llm = ctx.get('llm')
    if (route === undefined || llm === undefined || llm === null) {
      setState(sessionId, { status: 'off', text: null, reason: route === undefined ? 'no-model-route' : 'no-llm' })
      return
    }
    stats.catchUps += 1
    inflight.get(sessionId)?.abort()
    const controller = new AbortController()
    inflight.set(sessionId, controller)
    const started = Date.now()
    setState(sessionId, { status: 'pending', text: null, model: `${route.provider}/${route.model}`, catchUp: true })
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const result = await predict(llm, route, transcript, controller.signal)
      const text = result.text
      if (controller.signal.aborted) return
      stats.generated += 1
      stats.lastRaw = result.raw.slice(0, 300)
      if (text === null) stats.abstained += 1
      setState(sessionId, {
        status: text === null ? 'abstained' : 'ready',
        text,
        transcript,
        ms: Date.now() - started,
        catchUp: true,
      })
    } catch (error) {
      stats.failed += 1
      setState(sessionId, { status: 'error', text: null, reason: String(error) })
      noteError('catch-up', error)
    } finally {
      clearTimeout(timer)
      if (inflight.get(sessionId) === controller) inflight.delete(sessionId)
    }
  }

  /**
   * Schedule one debounced generation for a finished turn.
   * @param sessionId - the session identity.
   */
  const schedule = (sessionId) => {
    const existing = timers.get(sessionId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(sessionId)
      void generate(sessionId)
    }, DELAY_MS)
    timer.unref?.()
    timers.set(sessionId, timer)
  }

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          if (session === null || typeof session !== 'object') return
          if (event === null || typeof event !== 'object') return
          stats.observed += 1
          const sessionId = typeof session.id === 'string' ? session.id : ''
          if (sessionId.length === 0) return
          const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
          let record = records.get(sessionId)
          if (record === undefined) {
            record = { users: [], assistants: [], tools: [], route: undefined }
            records.set(sessionId, record)
          }
          if (event.type === 'request/header') {
            const route = routeOfHeaderEvent(event)
            if (route !== undefined) record.route = route
            return
          }
          if (event.type === 'user/message') {
            const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
            if (source.kind !== undefined && source.kind !== 'user') return
            const text = textOfEvent(data)
            if (text.length === 0) return
            record.users.push(text)
            if (record.users.length > MAX_USER_TURNS) record.users.shift()
            return
          }
          if (event.type === 'assistant/message') {
            const text = textOfEvent(data)
            if (text.length === 0) return
            record.assistants.push(text)
            if (record.assistants.length > MAX_ASSISTANT_TURNS) record.assistants.shift()
            return
          }
          if (event.type === 'tool/call') {
            const toolName = typeof data.name === 'string' ? data.name : ''
            if (toolName.length === 0) return
            record.tools.push(toolName)
            if (record.tools.length > MAX_TOOL_NAMES) record.tools.shift()
            return
          }
          if (event.type === 'turn/start') {
            running.add(sessionId)
            // A running turn makes the previous hint stale; the next end refreshes it.
            if (states.has(sessionId)) setState(sessionId, { status: 'running', text: null })
            // Do not spend a model call on a conversation that just moved on.
            inflight.get(sessionId)?.abort()
            const pendingTimer = timers.get(sessionId)
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer)
              timers.delete(sessionId)
            }
            return
          }
          if (event.type !== 'turn/end') return
          running.delete(sessionId)
          stats.turnEnds += 1
          if (!isUserSession(session)) {
            stats.skipped.subagent = (stats.skipped.subagent ?? 0) + 1
            return
          }
          schedule(sessionId)
        } catch (error) {
          noteError('session observer', error)
        }
      }),
    'autocomplete: session observer',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: (req, res) => {
          const url = new URL(req.url === undefined ? STATE_PATH : req.url, 'http://localhost')
          const sessionId = url.searchParams.get('session') ?? ''
          const inFlight = isRunningNow(sessionId)
          if (!inFlight && sessionId.length > 0 && !states.has(sessionId) && url.searchParams.get('catchUp') !== '0') {
            void catchUp(sessionId)
          }
          // A turn in flight always answers "no hint", whatever an older record says.
          const state = inFlight
            ? { sessionId, status: 'running', text: null, running: true }
            : { ...(states.get(sessionId) ?? { status: 'idle', text: null, sessionId }), running: false }
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(state))
        },
      }),
    'autocomplete: state route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PREDICT_PATH,
        handler: (req, res) => {
          const chunks = []
          req.on('data', (chunk) => chunks.push(chunk))
          req.on('end', () => {
            void (async () => {
              try {
                const body = Buffer.concat(chunks).toString('utf8')
                const parsed = body.length === 0 ? {} : JSON.parse(body)
                const transcript = typeof parsed.transcript === 'string' && parsed.transcript.length > 0
                  ? parsed.transcript
                  : 'USER: 帮我把 README 里的安装步骤补全\n\nASSISTANT: 已补全安装步骤，并新增了一节「验证」。\n\nTOOLS USED: read, edit'
                const route = defaultRoute()
                if (route === undefined) {
                  res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
                  res.end(JSON.stringify({ ok: false, reason: 'no-model-route' }))
                  return
                }
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
                const started = Date.now()
                const result = await predict(ctx.get('llm'), route, transcript, controller.signal)
                clearTimeout(timer)
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end(JSON.stringify({ ok: true, text: result.text, raw: result.raw, route, ms: Date.now() - started, transcript }))
              } catch (error) {
                noteError('predict route', error)
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: String(error) }))
              }
            })()
          })
        },
      }),
    'autocomplete: predict route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SEED_PATH,
        handler: (req, res) => {
          const chunks = []
          req.on('data', (chunk) => chunks.push(chunk))
          req.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
              const sessionId = typeof parsed.session === 'string' ? parsed.session : ''
              const text = typeof parsed.text === 'string' ? parsed.text : ''
              if (sessionId.length === 0) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, reason: 'session-required' }))
                return
              }
              setState(sessionId, { status: text.length > 0 ? 'ready' : 'idle', text, seeded: true })
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: true, sessionId, text }))
            } catch (error) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String(error) }))
            }
          })
        },
      }),
    'autocomplete: seed route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: TAP_PATH,
        handler: (req, res) => {
          const chunks = []
          req.on('data', (chunk) => chunks.push(chunk))
          req.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
              stats.taps.push({ at: Date.now(), ...parsed })
              if (stats.taps.length > 8) stats.taps.shift()
            } catch {
              // A malformed report never breaks the dialog.
            }
            res.writeHead(204, { 'cache-control': 'no-store' })
            res.end()
          })
        },
      }),
    'autocomplete: tap report',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SIMULATE_PATH,
        handler: (req, res) => {
          const chunks = []
          req.on('data', (chunk) => chunks.push(chunk))
          req.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
              const sessionId = typeof parsed.session === 'string' ? parsed.session : ''
              const phase = parsed.phase === 'start' ? 'start' : 'end'
              if (sessionId.length === 0) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, reason: 'session-required' }))
                return
              }
              if (phase === 'start') {
                running.add(sessionId)
                inflight.get(sessionId)?.abort()
                setState(sessionId, { status: 'running', text: null })
              } else {
                running.delete(sessionId)
                if (states.has(sessionId)) setState(sessionId, { status: 'idle', text: null })
              }
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: true, sessionId, phase, running: running.has(sessionId) }))
            } catch (error) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String(error) }))
            }
          })
        },
      }),
    'autocomplete: simulate turn',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: DEBUG_PATH,
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            ok: true,
            stats,
            states: [...states.entries()].map(([sessionId, state]) => ({ sessionId, ...state })),
            records: [...records.entries()].map(([sessionId, record]) => ({
              sessionId,
              users: record.users.length,
              assistants: record.assistants.length,
              tools: record.tools.length,
              route: record.route ?? null,
            })),
            running: [...running],
            llm: ctx.get('llm') !== undefined,
            defaults: ctx.get('agentDefaultModel') !== undefined,
          }))
        },
      }),
    'autocomplete: debug route',
  )

  ctx.effect(
    () => () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const controller of inflight.values()) controller.abort()
      inflight.clear()
      records.clear()
      states.clear()
    },
    'autocomplete: teardown',
  )
}
