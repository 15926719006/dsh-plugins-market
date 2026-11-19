/**
 * Host half of `@local/dsh-task-notify`.
 *
 * Watches the two moments a user can miss while another window has focus:
 *
 * - `session/event` → `turn/end`: the agent finished (or errored, or was
 *   interrupted) one turn of a top-level session;
 * - `user-questions/request` and `approval/request`: the agent is blocked on an
 *   answer only the user can give.
 *
 * Each moment becomes one small notification record, pushed to every connected
 * browser page over Server-Sent Events at `GET /plugins/task-notify/events`.
 * The page turns a record into a native desktop notification; when no page is
 * connected, or no page can show browser notifications, the Host posts the same
 * record through macOS `osascript` instead.
 *
 * Every record names the Session it came from (`sessionId`), so the page can
 * select that conversation when the card is clicked, and a record the Host
 * posted itself says so (`native`): such a card has no click action, and the
 * page navigates on the next window activation that the click causes.
 *
 * Subagent and teammate sessions are deliberately silent: only sessions the
 * user drives themselves produce a record.
 *
 * @module @local/dsh-task-notify
 */

import { execFile } from 'node:child_process'

/** Cordis plugin name. */
export const name = 'task-notify'

/** The browser carrier is the only Host service this row needs. */
export const inject = ['webServer']

/** Server-Sent Events stream the page subscribes to. */
export const EVENTS_PATH = '/plugins/task-notify/events'

/** Page handshake: reports its notification permission. */
export const HELLO_PATH = '/plugins/task-notify/hello'

/** Manual trigger, used by the page's own affordance and by the plugin tests. */
export const TEST_PATH = '/plugins/task-notify/test'

/** Read-only counters, so the wiring can be checked from the outside. */
export const DEBUG_PATH = '/plugins/task-notify/debug'

/** Longest assistant excerpt carried in one record. */
const MAX_EXCERPT = 200

/** Keepalive comment period for the event stream. */
const KEEPALIVE_MS = 25_000

/** Stand-in session title when the session has none yet. */
const FALLBACK_TITLE_ZH = '未命名会话'

/** Card headings, per page language, for the cards the Host posts itself. */
const KIND_LABELS = {
  zh: {
    completed: '任务完成',
    error: '任务出错',
    aborted: '任务已中止',
    interrupted: '任务被打断',
    'max-tokens': '任务到达长度上限',
    blocked: '任务被阻塞',
    question: '需要你回答',
    approval: '需要你审批',
    unknown: '任务有新进展',
  },
  en: {
    completed: 'Task finished',
    error: 'Task failed',
    aborted: 'Task stopped',
    interrupted: 'Task interrupted',
    'max-tokens': 'Task hit the length limit',
    blocked: 'Task blocked',
    question: 'Your answer is needed',
    approval: 'Your approval is needed',
    unknown: 'Task has an update',
  },
}

/** Turn-end kinds that are worth interrupting the user for. */
const NOTIFYING_KINDS = new Set([
  'completed',
  'error',
  'aborted',
  'interrupted',
  'max-tokens',
  'blocked',
])

/**
 * Join the text blocks of one message into one line.
 * @param message - an assistant message, or anything shaped like one.
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
 * Collapse whitespace and cut one excerpt to a readable length.
 * @param text - the raw text.
 * @param max - maximum characters, defaults to `MAX_EXCERPT`.
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
 * Last path segment of a workspace directory.
 * @param path - an absolute or relative directory path.
 * @returns the segment, or an empty string.
 */
export function basenameOf(path) {
  const raw = String(path === null || path === undefined ? '' : path)
  const parts = raw.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/**
 * Project one `turn/end` reason into a notification kind.
 * @param reason - the event's `data.reason`, as recorded.
 * @returns a stable kind string.
 */
export function kindOfReason(reason) {
  const kind = reason !== null && typeof reason === 'object' ? reason.kind : undefined
  return typeof kind === 'string' ? kind : 'unknown'
}

/**
 * Does this session belong to work the user drives directly?
 *
 * Only the durable session header decides, because a mis-filtered root session
 * would silently suppress every notification. Subagent work carries
 * `origin: 'subagent'` (or a delegation depth); everything else is the user's
 * own conversation.
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
 * Build the macOS `osascript` command lines for one record.
 *
 * A card posted this way belongs to the app, so it carries the same
 * `任务完成 · 会话标题` heading the browser card would have shown.
 * @param record - one notification record.
 * @returns the AppleScript source.
 */
export function appleScriptOf(record) {
  const escape = (value) =>
    String(value === null || value === undefined ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
  const label = escape(record.label)
  const title = escape(record.title)
  const heading = label.length === 0 ? title : title.length === 0 ? label : `${label} · ${title}`
  const subtitle = escape(record.subtitle)
  const body = escape(record.body)
  return `display notification "${body}" with title "${heading}" subtitle "${subtitle}" sound name "Glass"`
}

/**
 * Register the plugin.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx) {
  /** Live `text/event-stream` responses, each mapped to the page that opened it. */
  const clients = new Map()
  /**
   * Per-page notification permission.
   *
   * Several windows can watch one Host and only some of them may show browser
   * notifications, so the fallback card is posted only while no page can show
   * one — and a page that closes takes its permission with it.
   */
  const pages = new Map()
  /** Last permission any page reported, kept for the debug route. */
  let permission = 'unknown'
  /** Per-session turn scratch space, dropped when a turn closes. */
  const scratch = new Map()
  /** Observed-event counters: proof of what this Host listener really sees. */
  const stats = { sessionEvent: {}, turnEnd: {}, emitted: 0, questions: 0, approvals: 0, errors: [] }

  /** Pages that never named themselves still get a stable key. */
  let anonymousPages = 0

  /**
   * Record one caught observer failure.
   * @param where - where it happened.
   * @param error - the thrown value.
   */
  const noteError = (where, error) => {
    stats.errors.push(`${where}: ${String(error)}`)
    if (stats.errors.length > 8) stats.errors.shift()
  }

  /**
   * Read the page identity a request carries.
   * @param req - the HTTP request.
   * @returns the page key, or an empty string.
   */
  const pageOf = (req) => {
    try {
      const url = new URL(String(req === undefined || req === null ? '/' : req.url), 'http://plugin.invalid')
      return (url.searchParams.get('page') ?? '').trim()
    } catch {
      return ''
    }
  }

  /**
   * The page entry for one key, created on first contact.
   * @param key - page identity.
   * @returns the mutable page record.
   */
  const pageEntry = (key) => {
    const existing = pages.get(key)
    if (existing !== undefined) return existing
    const created = { permission: 'unknown', lang: '', opened: 0, at: Date.now() }
    pages.set(key, created)
    return created
  }

  /** Language of the pages currently loaded; the app is Chinese by default. */
  const languageOf = () => {
    for (const page of pages.values()) {
      if (page.lang === 'zh' || page.lang === 'en') return page.lang
    }
    return 'zh'
  }

  /**
   * Card heading for one record in the language the pages use.
   * @param kind - record kind.
   * @returns the heading text.
   */
  const labelOf = (kind) => {
    const table = KIND_LABELS[languageOf()] ?? KIND_LABELS.zh
    return table[String(kind)] ?? table.unknown
  }

  /** Does some connected page show browser notifications itself? */
  const browserCardsPossible = () => {
    for (const page of pages.values()) {
      if (page.permission === 'granted' && page.opened > 0) return true
    }
    return false
  }

  const roots = () => {
    const agents = ctx.get('agents')
    if (agents === undefined || agents === null) return new Set()
    try {
      return new Set(
        agents
          .roots()
          .map((agent) => agent.id)
          .filter((id) => typeof id === 'string'),
      )
    } catch {
      return new Set()
    }
  }

  const titleOf = (session, cwd) => {
    const titles = ctx.get('sessionTitle')
    if (titles !== undefined && titles !== null) {
      try {
        const snapshot = titles.get(session)
        if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.title === 'string') {
          const title = snapshot.title.trim()
          if (title.length > 0) return title
        }
      } catch {
        // A title service that refuses this session must not lose the record.
      }
    }
    const folder = basenameOf(cwd)
    return folder.length > 0 ? folder : FALLBACK_TITLE_ZH
  }

  /**
   * Session identity of an agent-scoped request.
   *
   * Answer and approval requests carry the asking agent, whose id is the
   * Session it belongs to; that is what a card has to point back at.
   * @param request - the waterfall request payload.
   * @returns the session id, or an empty string.
   */
  const agentSessionOf = (request) => {
    const agent = request !== null && typeof request === 'object' ? request.agent : undefined
    const id = agent !== null && typeof agent === 'object' ? agent.id : undefined
    return typeof id === 'string' ? id.trim() : ''
  }

  /**
   * Title of a Session that is only known by id.
   * @param sessionId - the session identity.
   * @returns the title, or an empty string when the Session is unknown.
   */
  const titleOfSession = (sessionId) => {
    if (sessionId.length === 0) return ''
    const sessions = ctx.get('sessions')
    if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return ''
    try {
      const session = sessions.get(sessionId)
      if (session === undefined || session === null) return ''
      const header = session.header !== null && typeof session.header === 'object' ? session.header : {}
      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      return titleOf(session, cwd)
    } catch {
      // A Session this Host cannot resolve still gets its card.
      return ''
    }
  }

  /**
   * Push one record to every connected page, then fall back to a card of our
   * own when no page can show one.
   *
   * The decision travels inside the record (`native`), so a page knows whether
   * it owns the click or whether the window activation after a card click is
   * the only signal it will get.
   * @param record - the notification record.
   * @returns what the delivery looked like.
   */
  const broadcast = (record) => {
    const native = clients.size === 0 || !browserCardsPossible()
    const payload = native ? { ...record, native } : record
    const line = `data: ${JSON.stringify(payload)}\n\n`
    let delivered = 0
    for (const res of clients.keys()) {
      try {
        res.write(line)
        delivered += 1
      } catch {
        clients.delete(res)
      }
    }
    if (native) postNative(record)
    return { delivered, native }
  }

  /**
   * Post one record through macOS Notification Center as a fallback.
   * @param record - the notification record.
   */
  const postNative = (record) => {
    if (process.platform !== 'darwin') return
    execFile(
      '/usr/bin/osascript',
      ['-e', appleScriptOf(record)],
      { timeout: 5_000 },
      (error) => {
        if (error !== null) ctx.logger.warn(`task-notify: osascript failed: ${error.message}`)
      },
    )
  }

  /**
   * Build and broadcast one record.
   * @param fields - record fields.
   * @returns the record as delivered.
   */
  const emit = (fields) => {
    stats.emitted += 1
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      time: Date.now(),
      ...fields,
      label: labelOf(fields.kind),
    }
    let delivery = { delivered: 0, native: true }
    try {
      delivery = broadcast(record)
    } catch (error) {
      ctx.logger.warn(`task-notify: broadcast failed: ${String(error)}`)
    }
    stats.lastDelivery = { at: record.time, ...delivery }
    return delivery.native ? { ...record, native: true } : record
  }

  // ---- turn completion -----------------------------------------------------

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          if (session === null || typeof session !== 'object') return
          if (event === null || typeof event !== 'object') return
          stats.sessionEvent[String(event.type)] = (stats.sessionEvent[String(event.type)] || 0) + 1
          const sessionId = typeof session.id === 'string' ? session.id : ''
          const data = event.data !== null && typeof event.data === 'object' ? event.data : {}

          if (event.type === 'assistant/message') {
            scratch.set(sessionId, { text: textOfMessage(data.message), turn: data.turn })
            return
          }
          if (event.type !== 'turn/end') return

          const turn = scratch.get(sessionId)
          scratch.delete(sessionId)
          const kind = kindOfReason(data.reason)
          stats.lastTurnEnd = { sessionId, kind, at: Date.now() }
          if (!isUserSession(session)) {
            stats.lastSkip = `subagent session ${sessionId}`
            return
          }
          stats.turnEnd[kind] = (stats.turnEnd[kind] || 0) + 1
          if (!NOTIFYING_KINDS.has(kind)) return

          const header = session.header !== null && typeof session.header === 'object' ? session.header : {}
          const cwd = typeof header.cwd === 'string' ? header.cwd : ''
          const excerpt = clip(turn !== undefined && typeof turn.text === 'string' ? turn.text : '')
          emit({
            kind,
            sessionId,
            title: titleOf(session, cwd),
            subtitle: '',
            body: excerpt,
            cwd,
            turn: typeof data.turn === 'number' ? data.turn : null,
          })
        } catch (error) {
          noteError('session observer', error)
          ctx.logger.warn(`task-notify: session observer failed: ${String(error)}`)
        }
      }),
    'task-notify: session observer',
  )

  // ---- the agent is waiting for the user -----------------------------------

  ctx.effect(
    () =>
      ctx.on('user-questions/request', (...args) => {
        const next = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
        stats.questions += 1
        try {
          const request = args[0]
          const questions = request !== null && typeof request === 'object' ? request.questions : undefined
          const first = Array.isArray(questions) && questions.length > 0 ? questions[0] : undefined
          const prompt =
            first !== null && typeof first === 'object' && typeof first.question === 'string'
              ? first.question
              : ''
          const sessionId = agentSessionOf(request)
          emit({
            kind: 'question',
            sessionId,
            title: titleOfSession(sessionId),
            subtitle: '',
            body: clip(prompt),
          })
        } catch (error) {
          noteError('question observer', error)
          ctx.logger.warn(`task-notify: question observer failed: ${String(error)}`)
        }
        return next === undefined ? undefined : next()
      }),
    'task-notify: question observer',
  )

  ctx.effect(
    () =>
      ctx.on('approval/request', (...args) => {
        const next = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
        stats.approvals += 1
        try {
          const request = args[0]
          const sessionId = agentSessionOf(request)
          emit({
            kind: 'approval',
            sessionId,
            title: titleOfSession(sessionId),
            subtitle: '',
            body: '有一个操作在等你批准。',
          })
        } catch (error) {
          noteError('approval observer', error)
          ctx.logger.warn(`task-notify: approval observer failed: ${String(error)}`)
        }
        return next === undefined ? undefined : next()
      }),
    'task-notify: approval observer',
  )

  // ---- browser transport ---------------------------------------------------

  const keepalive = setInterval(() => {
    for (const res of clients.keys()) {
      try {
        res.write(': ping\n\n')
      } catch {
        clients.delete(res)
      }
    }
  }, KEEPALIVE_MS)
  keepalive.unref?.()

  ctx.effect(
    () => () => {
      clearInterval(keepalive)
      for (const res of clients.keys()) {
        try {
          res.end()
        } catch {
          // already gone
        }
      }
      clients.clear()
      pages.clear()
    },
    'task-notify: stream teardown',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: EVENTS_PATH,
        handler: (req, res) => {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          res.write(': connected\n\n')
          const key = pageOf(req) || `anonymous-${(anonymousPages += 1)}`
          const page = pageEntry(key)
          page.opened += 1
          page.at = Date.now()
          clients.set(res, key)
          const drop = () => {
            if (!clients.delete(res)) return
            const entry = pages.get(key)
            if (entry === undefined) return
            entry.opened = Math.max(0, entry.opened - 1)
            // A page that went away takes its permission with it: a stale
            // "granted" would silence the fallback card forever.
            if (entry.opened === 0) pages.delete(key)
          }
          req.on('close', drop)
          res.on('close', drop)
        },
      }),
    'task-notify: event stream',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: HELLO_PATH,
        handler: (req, res) => {
          let body = ''
          req.on('data', (chunk) => {
            if (body.length < 4096) body += chunk
          })
          req.on('end', () => {
            try {
              const parsed = body.length === 0 ? {} : JSON.parse(body)
              const key = typeof parsed.page === 'string' ? parsed.page.trim() : ''
              if (key.length > 0) {
                const page = pageEntry(key)
                if (typeof parsed.permission === 'string') {
                  page.permission = parsed.permission
                  permission = parsed.permission
                }
                if (parsed.lang === 'zh' || parsed.lang === 'en') page.lang = parsed.lang
                page.at = Date.now()
              } else if (typeof parsed.permission === 'string') {
                permission = parsed.permission
              }
            } catch {
              // A malformed handshake only leaves the previous permission.
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true }))
          })
        },
      }),
    'task-notify: handshake route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: DEBUG_PATH,
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(
            JSON.stringify({
              ok: true,
              stats,
              roots: [...roots()],
              clients: clients.size,
              permission,
              pages: [...pages].map(([key, page]) => ({ page: key, ...page })),
              sessions: [...scratch.keys()],
            }),
          )
        },
      }),
    'task-notify: debug route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: TEST_PATH,
        handler: (req, res) => {
          const url = new URL(String(req.url === undefined ? '/' : req.url), 'http://plugin.invalid')
          const force = url.searchParams.get('force') === '1'
          // A real Session id makes the click navigable, which is what the
          // verification of the card path needs.
          const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
          const record = emit({
            kind: 'completed',
            sessionId,
            title: sessionId.length === 0 ? '通知测试' : titleOfSession(sessionId),
            subtitle: '',
            body: '看到这条通知，说明电脑通知已经生效。',
            cwd: '',
            turn: null,
            force,
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, clients: clients.size, permission, record }))
        },
      }),
    'task-notify: test route',
  )
}
