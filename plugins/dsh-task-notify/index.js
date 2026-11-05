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
 * connected, or the page reports that the browser refused notifications, the
 * Host posts the same record through macOS `osascript` instead.
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
 * @param record - one notification record.
 * @returns the AppleScript source.
 */
export function appleScriptOf(record) {
  const escape = (value) =>
    String(value === null || value === undefined ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
  const title = escape(record.title)
  const subtitle = escape(record.subtitle)
  const body = escape(record.body)
  return `display notification "${body}" with title "${title}" subtitle "${subtitle}" sound name "Glass"`
}

/**
 * Register the plugin.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx) {
  /** Live `text/event-stream` responses. */
  const clients = new Set()
  /** Last permission a page reported: `granted`, `denied`, `default`, `unsupported`. */
  let permission = 'unknown'
  /** Per-session turn scratch space, dropped when a turn closes. */
  const scratch = new Map()
  /** Observed-event counters: proof of what this Host listener really sees. */
  const stats = { sessionEvent: {}, turnEnd: {}, emitted: 0, questions: 0, approvals: 0, errors: [] }

  /**
   * Record one caught observer failure.
   * @param where - where it happened.
   * @param error - the thrown value.
   */
  const noteError = (where, error) => {
    stats.errors.push(`${where}: ${String(error)}`)
    if (stats.errors.length > 8) stats.errors.shift()
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
   * Push one record to every connected page.
   * @param record - the notification record.
   * @returns number of pages that received it.
   */
  const broadcast = (record) => {
    const line = `data: ${JSON.stringify(record)}\n\n`
    let delivered = 0
    for (const res of clients) {
      try {
        res.write(line)
        delivered += 1
      } catch {
        clients.delete(res)
      }
    }
    if (delivered === 0 || permission === 'denied' || permission === 'unsupported') {
      postNative(record)
    }
    return delivered
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
   */
  const emit = (fields) => {
    stats.emitted += 1
    const record = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, time: Date.now(), ...fields }
    try {
      broadcast(record)
    } catch (error) {
      ctx.logger.warn(`task-notify: broadcast failed: ${String(error)}`)
    }
    return record
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
          emit({ kind: 'question', sessionId: '', title: '需要你回答', subtitle: '', body: clip(prompt) })
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
          emit({ kind: 'approval', sessionId: '', title: '需要你审批', subtitle: '', body: '有一个操作在等你批准。' })
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
    for (const res of clients) {
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
      for (const res of clients) {
        try {
          res.end()
        } catch {
          // already gone
        }
      }
      clients.clear()
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
          clients.add(res)
          const drop = () => clients.delete(res)
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
              if (typeof parsed.permission === 'string') permission = parsed.permission
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
          const force = String(req.url === undefined ? '' : req.url).includes('force=1')
          const record = emit({
            kind: 'completed',
            sessionId: '',
            title: '通知测试',
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
