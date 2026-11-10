/**
 * Turn one devops reference into the number and title the platform itself
 * gives it — `{ number, title }` — or `null`.
 *
 * This module is deliberately forgiving: a rename click must never fail because
 * a platform answered slowly, a token was revoked, or a link pointed at a
 * record that was deleted. Every path that is not a clean answer returns
 * `null`, and nothing here throws.
 *
 * ## The read-only routes, and the fields they answer with
 *
 * All verified against the live platform on 2026-11-10 with an API key
 * (`Authorization: Bearer rhk_…`). None of them writes.
 *
 * | kind | request | number field | title field |
 * |---|---|---|---|
 * | demand | `GET /api/devops/demand/detail/<RO>` | `data.order.orderId` | `data.order.title` |
 * | demand (fallback) | `POST /api/devops/demand/query {orderId}` | `data.list[0].orderId` | `data.list[0].title` |
 * | release | `POST /api/devops/release/order/detail {orderId}` | `data.orderId` | `data.title` |
 * | release (fallback) | `POST /api/devops/release/order/query {orderId}` | `data.records[0].orderId` | `data.records[0].title` |
 * | task | `GET /api/devops/task/detail/<T-no or 19-digit id>` | `data.taskNo` | `data.name` |
 * | defect | `GET /api/devops/defect/detail/<BUG-no>` | `data.defectNo` | `data.name` |
 * | issue | `GET /api/devops/issue/query?key=<ON3-no>` | `data.key` | `data.summary` |
 * | project | `GET /api/devops/project/detail/<P-no>` | `data.projectNo` | `data.name` |
 * | subtask | `GET /api/devops/subtask/detail/<RO-…-S04>` | `data.subtaskNo` | `data.name` |
 *
 * ## How the platform says no
 *
 * | case | answer |
 * |---|---|
 * | bad key | HTTP 401, `respCode: 40100` 「API Key 不存在」 |
 * | unknown task | HTTP 404, `respCode: 40400` 「任务不存在」 |
 * | unknown defect | HTTP 404, `respCode: 40400` 「缺陷不存在」 |
 * | unknown project | HTTP 404, `respCode: 40400` 「专项不存在」 |
 * | unknown release order | HTTP 404, `respCode: 40004` 「发布单 … 不存在」 |
 * | unknown issue | HTTP 404, `respCode: ISSUE_NOT_FOUND` (not a number) |
 * | unknown demand | **HTTP 500 with an EMPTY body** — the only route that answers garbage (hence the `demand/query` fallback) |
 * | route not whitelisted for API keys | `respCode: 40300` |
 *
 * Because `respCode` is sometimes a word, the check is `!== '20000'`, never a
 * numeric comparison.
 */

import { DEFAULT_BASE_URL } from './devops-credentials.mjs'
import { kindOfRef } from './devops-refs.mjs'

/** The envelope code that means success. */
const SUCCESS = '20000'

/** How long one request may take before it is abandoned, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5000

/**
 * A resolved record.
 *
 * @typedef {object} DevopsRecordTitle
 * @property {string} number - the platform's own number for the record.
 * @property {string} title - the platform's own title (`title`, `name` or `summary`).
 */

/**
 * One authenticated read, unwrapped to the platform's `data`.
 *
 * @param {{ baseUrl: string, token: string }} credentials - where and as whom to read.
 * @param {typeof fetch} fetchImpl - the fetch to use.
 * @param {number} timeoutMs - the per-request budget.
 * @returns {(method: string, path: string, body?: unknown) => Promise<any|null>} the caller.
 */
function createCaller(credentials, fetchImpl, timeoutMs) {
  const baseUrl = String(credentials.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const token = String(credentials.token ?? '')
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  }
  return async function call(method, path, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: 'follow',
      })
      const text = await response.text()
      let parsed = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        // An empty or HTML body is not an answer. (Unknown demand answers 500
        // with an empty body, so this is a real case, not a theoretical one.)
        return null
      }
      if (parsed === null || typeof parsed !== 'object') return null
      const respCode = parsed.respCode
      if (respCode !== undefined && respCode !== null && String(respCode) !== SUCCESS) return null
      if (respCode === undefined && response.ok === false) return null
      return 'data' in parsed ? parsed.data : parsed
    } catch {
      // Network failure, DNS failure, timeout, aborted fetch: all the same here.
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Collapse a platform title to one line, so it can be a title prefix.
 * @param {unknown} value - the platform's title.
 * @returns {string} one line, without the spaces at either end.
 */
function oneLine(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * The 19-digit id or the number, encoded for a path segment.
 * @param {string} value - the identifier.
 * @returns {string} the encoded identifier.
 */
function segment(value) {
  return encodeURIComponent(String(value ?? '').trim())
}

/**
 * One reader per kind: ask the cheapest route that answers with a number and a
 * title, and fall back to the list route where the platform's detail route is
 * unreliable.
 *
 * @type {Record<string, (call: (method: string, path: string, body?: unknown) => Promise<any|null>, ref: string) => Promise<DevopsRecordTitle|null>>}
 */
const READERS = {
  async demand(call, ref) {
    const detail = await call('GET', `/api/devops/demand/detail/${segment(ref)}`)
    const order = detail?.order ?? null
    if (order && oneLine(order.title).length > 0) {
      return { number: String(order.orderId ?? ref), title: oneLine(order.title) }
    }
    // Unknown demands answer 500 with no envelope at all, so query is the
    // route that can tell "gone" from "broken".
    const queried = await call('POST', '/api/devops/demand/query', { pageNum: 1, pageSize: 5, orderId: ref })
    const row = queried?.list?.[0]
    if (row && oneLine(row.title).length > 0) {
      return { number: String(row.orderId ?? ref), title: oneLine(row.title) }
    }
    return null
  },

  async release(call, ref) {
    const detail = await call('POST', '/api/devops/release/order/detail', { orderId: ref })
    if (detail && oneLine(detail.title).length > 0) {
      return { number: String(detail.orderId ?? ref), title: oneLine(detail.title) }
    }
    const queried = await call('POST', '/api/devops/release/order/query', { pageNum: 1, pageSize: 5, orderId: ref })
    const row = queried?.records?.[0] ?? queried?.list?.[0]
    if (row && oneLine(row.title).length > 0) {
      return { number: String(row.orderId ?? ref), title: oneLine(row.title) }
    }
    return null
  },

  async task(call, ref) {
    // The detail route accepts both the taskNo (`T-…`) and the 19-digit id —
    // verified, so there is no need to resolve one into the other.
    const detail = await call('GET', `/api/devops/task/detail/${segment(ref)}`)
    if (detail && oneLine(detail.name).length > 0) {
      return { number: String(detail.taskNo ?? ref), title: oneLine(detail.name) }
    }
    return null
  },

  async defect(call, ref) {
    // `detail` takes the defectNo only: a numeric id answers 40400 缺陷不存在,
    // and `defect/list` ignores every filter, so a numeric id is not resolvable
    // without scanning the whole list (see README, 已知边界).
    if (/^\d+$/.test(String(ref))) return null
    const detail = await call('GET', `/api/devops/defect/detail/${segment(ref)}`)
    if (detail && oneLine(detail.name).length > 0) {
      return { number: String(detail.defectNo ?? ref), title: oneLine(detail.name) }
    }
    return null
  },

  async issue(call, ref) {
    const data = await call('GET', `/api/devops/issue/query?key=${segment(ref)}`)
    if (data && oneLine(data.summary).length > 0) {
      return { number: String(data.key ?? ref), title: oneLine(data.summary) }
    }
    return null
  },

  async project(call, ref) {
    const detail = await call('GET', `/api/devops/project/detail/${segment(ref)}`)
    if (detail && oneLine(detail.name).length > 0) {
      return { number: String(detail.projectNo ?? ref), title: oneLine(detail.name) }
    }
    return null
  },

  async subtask(call, ref) {
    const detail = await call('GET', `/api/devops/subtask/detail/${segment(ref)}`)
    if (detail && oneLine(detail.name).length > 0) {
      return { number: String(detail.subtaskNo ?? ref), title: oneLine(detail.name) }
    }
    return null
  },
}

/**
 * The kind to read a reference as.
 * @param {string|{ kind?: string, ref?: string }} ref - a number, or a ref record.
 * @returns {{ kind: string, ref: string }} the kind and number.
 */
function normalizeRef(ref) {
  if (ref !== null && typeof ref === 'object') {
    const value = String(ref.ref ?? '').trim()
    const declared = String(ref.kind ?? '')
    if (declared in READERS) return { kind: declared, ref: value }
    const inferred = kindOfRef(value)
    // A bare snowflake id is only unambiguous for a task: `task/detail` is the
    // one route on the platform that accepts an id in place of a number.
    return { kind: inferred ?? (/^\d{15,20}$/.test(value) ? 'task' : 'demand'), ref: value }
  }
  const value = String(ref ?? '').trim()
  const inferred = kindOfRef(value)
  return { kind: inferred ?? (/^\d{15,20}$/.test(value) ? 'task' : 'demand'), ref: value }
}

/**
 * Read one devops record's number and title. Never throws, never writes.
 *
 * @param {string|{ kind?: string, ref?: string }} ref - the number (`RO-…`,
 *   `T-…`, `ON3-…`, `BUG-…`, `P-…`, `RO-…-S04`, a 19-digit id) or a ref record
 *   from `findDevopsRefs`.
 * @param {{ baseUrl?: string, token?: string }|null|undefined} credentials -
 *   the credential; when it carries no token nothing is requested and the answer
 *   is `null`.
 * @param {typeof fetch} [fetchImpl] - the fetch to use; defaults to the global one.
 * @param {{ timeoutMs?: number }} [options] - the per-request budget (5 s by default).
 * @returns {Promise<DevopsRecordTitle|null>} the number and title, or null.
 */
export async function resolveDevopsTitle(ref, credentials, fetchImpl = globalThis.fetch, options = {}) {
  try {
    const token = String(credentials?.token ?? '').trim()
    if (token.length === 0) return null
    if (typeof fetchImpl !== 'function') return null

    const { kind, ref: value } = normalizeRef(ref)
    if (value.length === 0) return null
    const reader = READERS[kind]
    if (!reader) return null

    const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const call = createCaller(
      { baseUrl: String(credentials?.baseUrl ?? DEFAULT_BASE_URL), token },
      fetchImpl,
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    )
    const result = await reader(call, value)
    if (!result) return null
    return { number: result.number, title: result.title }
  } catch {
    return null
  }
}

/**
 * Read the first reference that resolves.
 *
 * A conversation usually name-drops several records — a requirement, its
 * release order, a defect. The first one that answers wins, which is why the
 * caller should pass `findDevopsRefs`' order straight through (first
 * appearance first). The reads are sequential and stop at the first answer, so
 * a click costs one or two requests, not one per link.
 *
 * @param {Array<{ kind?: string, ref?: string, url?: string|null }>} refs - the references, in order.
 * @param {{ baseUrl?: string, token?: string }|null|undefined} credentials - the credential.
 * @param {typeof fetch} [fetchImpl] - the fetch to use.
 * @param {{ timeoutMs?: number, limit?: number }} [options] - the per-request
 *   budget and how many references to try (3 by default).
 * @returns {Promise<(DevopsRecordTitle & { kind: string, ref: string, url: string|null })|null>} the first answer, or null.
 */
export async function resolveFirstDevopsTitle(refs, credentials, fetchImpl = globalThis.fetch, options = {}) {
  const list = Array.isArray(refs) ? refs : []
  const limit = Math.max(1, Math.min(Number(options.limit ?? 3), list.length))
  for (const ref of list.slice(0, limit)) {
    const resolved = await resolveDevopsTitle(ref, credentials, fetchImpl, options)
    if (resolved) {
      const { kind, ref: value } = normalizeRef(ref)
      return { ...resolved, kind, ref: value, url: ref?.url ?? null }
    }
  }
  return null
}

/**
 * The prefix a title should carry, in the form `编号 标题`.
 *
 * The caller owns the final wording — this is the shape the task asked for
 * (`devops 任务编号 + 该任务在 devops 上的标题` → 「编号 标题」), kept in one
 * place so the two halves are never separated.
 * @param {{ number?: string, title?: string }|null} result - a resolved record.
 * @returns {string} the prefix, or an empty string when nothing resolved.
 */
export function formatDevopsPrefix(result) {
  const number = oneLine(result?.number)
  const title = oneLine(result?.title)
  if (number.length === 0) return title
  if (title.length === 0) return number
  return `${number} ${title}`
}

export { DEFAULT_TIMEOUT_MS }
