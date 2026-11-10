/**
 * Find the DevOps links and numbers that appear in free text (a chat turn, a
 * transcript, a title).
 *
 * Everything here is pure: no I/O, no network, no clock. The caller decides
 * what to do with the refs it gets back — see `devops-resolve.mjs` for turning
 * one of them into `{ number, title }`.
 *
 * ## What the platform's links look like
 *
 * The platform has moved between two routers, and both shapes still circulate
 * in real conversations (counts from 233 local session logs, 2026-11):
 *
 * | shape | real sample | kind |
 * |---|---|---|
 * | `/#demand/<RO>` | `https://devops.ronhan.com/#demand/RO-20261027-008` | demand |
 * | `/#demand/<RO>?mode=edit` | `…/#demand/RO-20261020-018?mode=edit` | demand |
 * | `…&from=%23personal-todo` | `…/#demand/RO-20261020-018?mode=edit&from=%23personal-todo` | demand |
 * | `/#/demand/<RO>` | `…#/demand/RO-…` (hash with a leading slash) | demand |
 * | `/demand/<RO>` | `…/demand/RO-20261027-008` (path router) | demand |
 * | `/#task/<T>` | `…/#task/T-20261026-016` | task |
 * | `/task/<T>#task-management` | `…/task/T-20261023-012#task-management` | task |
 * | `/task/<19 位数字 id>` | `…/task/373000146054680576` | task |
 * | `/task/detail/<id>` | `…/task/detail/373000146054680576` | task |
 * | `/#release/<RO>` | `…/#release/RO-20260922-001` | release |
 * | `/#release/order/<RO>` | `…/#release/order/RO-20260922-001?mode=edit` | release |
 * | `/release/order/detail?orderId=<RO>` | `…/release/order/detail?orderId=RO-20261020-018` | release |
 * | `/release/order/detail/<RO>` | `…/release/order/detail/RO-20260922-001` | release |
 * | `/#project-management/<P>` | `…/#project-management/P-20260908-001` | project |
 * | `/project-management/<P>` | `…/project-management/P-20260908-001` | project |
 * | `/subtask/<RO>-S04` | `…/subtask/RO-20260911-026-S04` | subtask |
 * | `/login?redirect=…` | `…/login?redirect=%2Ftask%2Fdetail%2F373…` | whatever it wraps |
 *
 * `#defect/<BUG-…>` and `#issue/<ON3-…>` never showed up as a link in the
 * logs, but the platform has both record types and both detail routes, so the
 * patterns are accepted here (see README) — a link the platform publishes
 * later will be read without a code change.
 *
 * Note the identifier clash: an `RO-…` is both a 需求单 (demand) and, once it
 * has a release order, that order's number. The route disambiguates
 * (`#release/…` vs `#demand/…`); a bare `RO-…` with no route is read as a
 * demand, which is what it is in prose.
 */

/** The platform's host. */
const HOST = 'devops.ronhan.com'

/**
 * One devops reference found in text.
 *
 * @typedef {object} DevopsRef
 * @property {'demand'|'task'|'issue'|'defect'|'project'|'release'|'subtask'} kind - what the reference points at.
 * @property {string} ref - the number (`RO-…`, `T-…`, `ON3-…`, `BUG-…`, `P-…`, `RO-…-S04`) or the 19-digit id.
 * @property {string|null} url - the link it came from, or null when only the number was written.
 * @property {'url'|'text'} source - whether a link carried it or the bare number did.
 */

/**
 * A devops URL. Trailing punctuation, quotes, brackets and the CJK punctuation
 * that Chinese prose puts straight after a link are not part of the URL.
 */
const URL_RE = /https?:\/\/(?:www\.)?devops\.ronhan\.com[^\s"'`<>()[\]{}|\\^~，。；、：！？）】」』》]*/gi

/** The punctuation that often follows a URL without belonging to it. */
const TRAILING = /[.,;:!?，。；：！？、）】」』》"'`]+$/

/**
 * The numbers the platform issues, longest first so `RO-…-S04` is not read as
 * an `RO-…`. The lookarounds keep a match from starting in the middle of a
 * longer token (`xRO-…`, `RO-…S`).
 */
const BARE_RE = /(?<![A-Za-z0-9_-])(RO-\d{8}-\d{1,4}-S\d{1,2}|RO-\d{8}-\d{1,4}|T-\d{8}-\d{1,4}|P-\d{8}-\d{1,4}|BUG-\d{8}-\d{1,4}|ON3-\d{1,8})(?![A-Za-z0-9_])/g

/** A 19-digit snowflake id used as a route segment. */
const ID_IN_PATH_RE = /\/(\d{15,20})(?=[/?#]|$)/

/**
 * The kind a bare number belongs to, from its shape alone.
 * @param {string} ref - the number.
 * @returns {DevopsRef['kind']|null} the kind, or null when the shape is unknown.
 */
export function kindOfRef(ref) {
  const value = String(ref ?? '').trim().toUpperCase()
  if (/^RO-\d{8}-\d{1,4}-S\d{1,2}$/.test(value)) return 'subtask'
  if (/^RO-/.test(value)) return 'demand'
  if (/^T-/.test(value)) return 'task'
  if (/^P-/.test(value)) return 'project'
  if (/^BUG-/.test(value)) return 'defect'
  if (/^ON3-/.test(value)) return 'issue'
  if (/^\d{15,20}$/.test(value)) return null
  return null
}

/**
 * Whether a string is a link to the DevOps platform.
 * @param {unknown} value - the candidate.
 * @returns {boolean} true when it points at `devops.ronhan.com`.
 */
export function isDevopsUrl(value) {
  const text = String(value ?? '').trim()
  return /^https?:\/\/(?:www\.)?devops\.ronhan\.com(?:[/?#]|$)/i.test(text)
}

/**
 * The route a URL points at: the hash when it has one (the old hash router put
 * the whole route there), otherwise the path plus its query.
 * @param {string} url - the link.
 * @returns {string} something like `demand/RO-…?mode=edit`.
 */
function routeOf(url) {
  const text = String(url)
  const hashAt = text.indexOf('#')
  if (hashAt !== -1 && /[a-z]/i.test(text.slice(hashAt + 1))) {
    return text.slice(hashAt + 1).replace(/^\/+/, '')
  }
  try {
    const parsed = new URL(text)
    return `${parsed.pathname.replace(/^\/+/, '')}${parsed.search}`
  } catch {
    const withoutScheme = text.replace(/^https?:\/\//i, '')
    const firstSlash = withoutScheme.indexOf('/')
    return firstSlash === -1 ? '' : withoutScheme.slice(firstSlash + 1)
  }
}

/**
 * The kind a route names, from the words in its path segments.
 *
 * `project-management` and `task-management` are route words, not record
 * words, so they are read as project and task.
 * @param {string} route - the route.
 * @returns {DevopsRef['kind']|null} the kind, or null when the route says nothing.
 */
function kindOfRoute(route) {
  const segments = String(route).toLowerCase().split(/[/?#&=]/).filter(Boolean)
  for (const segment of segments) {
    if (segment === 'demand' || segment === 'demands') return 'demand'
    if (segment === 'task' || segment === 'tasks' || segment === 'task-management') return 'task'
    if (segment === 'release' || segment === 'releases' || segment === 'release-order') return 'release'
    if (segment === 'project' || segment === 'projects' || segment === 'project-management') return 'project'
    if (segment === 'defect' || segment === 'defects' || segment === 'bug' || segment === 'bugs') return 'defect'
    if (segment === 'issue' || segment === 'issues') return 'issue'
    if (segment === 'subtask' || segment === 'subtasks') return 'subtask'
  }
  return null
}

/**
 * The first number written in a piece of text, with the kind its shape implies.
 * @param {string} text - the text to search.
 * @returns {{ ref: string, kind: DevopsRef['kind']|null }|null} the number, or null.
 */
function refInText(text) {
  const matcher = new RegExp(BARE_RE.source, 'g')
  const match = matcher.exec(text)
  if (!match) return null
  const ref = match[1]
  return { ref, kind: kindOfRef(ref) }
}

/**
 * Read one devops URL into a reference.
 *
 * The route decides the kind first (a `#release/RO-…` is a release order, not
 * a demand), and the number decides it when the route says nothing. Links that
 * went through the login redirect (`/login?redirect=%2Ftask%2F…`) are followed
 * into the encoded target.
 * @param {string} url - the link.
 * @returns {DevopsRef|null} the reference, or null when the link carries none.
 */
export function parseDevopsUrl(url) {
  return parseOneUrl(url, 0)
}

/**
 * The same read, with a depth guard: a `redirect=` parameter can point at
 * another `redirect=` link, and a loop must not hang the parse.
 * @param {string} url - the link.
 * @param {number} depth - how many redirects have been followed.
 * @returns {DevopsRef|null} the reference, or null.
 */
function parseOneUrl(url, depth) {
  const text = String(url ?? '').trim()
  if (!isDevopsUrl(text)) return null

  // A login detour still knows where it was going: read that instead.
  const redirect = /[?&]redirect=([^&#]+)/i.exec(text)
  if (redirect && depth < 3) {
    let target = redirect[1]
    try {
      target = decodeURIComponent(target)
    } catch {
      target = target
    }
    const absolute = isDevopsUrl(target)
      ? target
      : `https://${HOST}${target.startsWith('/') ? '' : '/'}${target}`
    const parsed = parseOneUrl(absolute, depth + 1)
    return parsed ? { ...parsed, url: text } : null
  }

  const route = routeOf(text)
  // The route says what the link is, but the whole address says which record:
  // `/task/T-20261026-016#task-management` keeps its number in the path and its
  // route word in the hash.
  const haystack = text.replace(/^https?:\/\/(?:www\.)?devops\.ronhan\.com/i, '')
  const routeKind = kindOfRoute(route)

  // An explicit parameter beats a number that merely sits in the path.
  const orderId = /[?&]orderId=([^&#]+)/i.exec(text)
  const key = /[?&]key=([^&#]+)/i.exec(text)
  for (const raw of [orderId?.[1], key?.[1]]) {
    if (!raw) continue
    let value = raw
    try {
      value = decodeURIComponent(value)
    } catch {
      value = value
    }
    const inner = refInText(value)
    if (inner?.kind) {
      return { kind: routeKind ?? inner.kind, ref: inner.ref, url: text, source: 'url' }
    }
  }

  const found = refInText(haystack)
  if (found) {
    return { kind: routeKind ?? found.kind ?? 'demand', ref: found.ref, url: text, source: 'url' }
  }

  // `/task/373…` names a task by its snowflake id.
  const idMatch = ID_IN_PATH_RE.exec(haystack)
  if (idMatch) {
    return { kind: routeKind ?? 'task', ref: idMatch[1], url: text, source: 'url' }
  }

  return null
}

/**
 * Every devops reference in a piece of text, deduplicated, in the order they
 * first appear.
 *
 * Both links and bare numbers are read: people paste a link once and then keep
 * writing `RO-20261023-040` in prose. A number that sits inside a link is
 * reported once, from the link (so its kind is the route's kind, not the shape's).
 *
 * @param {string} text - any text: a transcript, a turn, a title.
 * @returns {DevopsRef[]} the references, first appearance first.
 */
export function findDevopsRefs(text) {
  const input = typeof text === 'string' ? text : String(text ?? '')
  if (input.length === 0) return []

  /** @type {Array<DevopsRef & { at: number }>} */
  const found = []
  /** @type {Array<[number, number]>} */
  const taken = []

  const urlMatcher = new RegExp(URL_RE.source, 'gi')
  let match
  while ((match = urlMatcher.exec(input)) !== null) {
    const raw = match[0].replace(TRAILING, '')
    const parsed = parseDevopsUrl(raw)
    const start = match.index
    const end = match.index + raw.length
    if (parsed) {
      found.push({ ...parsed, at: start })
      taken.push([start, end])
    } else if (end > start) {
      // Still a devops URL: keep its span so bare numbers inside are not
      // reported twice (a `#release/` link should not yield a demand as well).
      taken.push([start, end])
    }
  }

  // A number inside a link is already reported by that link.
  let masked = input
  for (const [start, end] of taken) {
    masked = masked.slice(0, start) + ' '.repeat(end - start) + masked.slice(end)
  }

  const bareMatcher = new RegExp(BARE_RE.source, 'g')
  while ((match = bareMatcher.exec(masked)) !== null) {
    const ref = match[1]
    const kind = kindOfRef(ref)
    if (!kind) continue
    found.push({ kind, ref, url: null, source: 'text', at: match.index })
  }

  found.sort((a, b) => a.at - b.at)

  /** @type {Map<string, DevopsRef>} */
  const unique = new Map()
  for (const { at: _at, ...ref } of found) {
    const key = `${ref.kind}:${ref.ref.toUpperCase()}`
    if (!unique.has(key)) unique.set(key, ref)
  }
  return [...unique.values()]
}

/**
 * The single reference a title should be built from: a link that names a whole
 * record first, then a link with a bare 19-digit id (still a link, and the
 * task detail route accepts it), and only then a number written in prose.
 * @param {DevopsRef[]} refs - the references in order.
 * @returns {DevopsRef|null} the reference to use, or null when there are none.
 */
export function primaryDevopsRef(refs) {
  const list = Array.isArray(refs) ? refs : []
  const isId = (ref) => /^\d+$/.test(ref.ref)
  return (
    list.find((ref) => ref.source === 'url' && !isId(ref)) ??
    list.find((ref) => ref.source === 'url') ??
    list[0] ??
    null
  )
}

export { HOST }
