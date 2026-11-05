/**
 * Host half of `@local/dsh-opencode-quota`.
 *
 * Owns the two things the browser must not do itself:
 *
 * - resolving the OpenCode Go API key through the Harness credentials seam
 *   (`OPENCODE_GO_API_KEY`), so the secret never reaches the page;
 * - one read-only route, `GET /plugins/opencode-quota/usage`, that asks the
 *   subscription endpoint
 *
 *     GET https://opencode.ai/zen/go/v1/usage
 *     Authorization: Bearer <api-key>
 *
 *   which answers `{ usage: { rolling, weekly, monthly } }`, each window
 *   carrying `status`, `percent` (used) and `resetsAt`.
 *
 * The upstream answer is projected to percentages only: OpenCode Go's money
 * limits differ per model, so a converted currency amount would mislead. A
 * successful answer is cached for 30 seconds; a failure is never cached.
 *
 * @module @local/dsh-opencode-quota
 */

/** Cordis plugin name. */
export const name = 'opencode-quota'

/** The credentials seam is the only Host service this row needs. */
export const inject = ['credentials', 'webServer']

/** Pathname the browser reads. Local to the bound web server. */
export const USAGE_PATH = '/plugins/opencode-quota/usage'

/** Subscription usage endpoint. */
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/** Credential reference holding the OpenCode Go API key. */
const CREDENTIAL_REF = 'OPENCODE_GO_API_KEY'

/** How long one successful upstream answer is reused. */
const CACHE_MS = 30_000

/** Upstream request ceiling. */
const TIMEOUT_MS = 12_000

/** Windows the subscription endpoint reports, in display order. */
const WINDOW_KEYS = ['rolling', 'weekly', 'monthly']

/**
 * Clamp one upstream percentage into 0..100.
 * @param value - the raw value.
 * @returns the clamped number, or null when it is not a finite number.
 */
function percentOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, value))
}

/**
 * Project one upstream usage window.
 * @param key - window key (`rolling`, `weekly`, `monthly`).
 * @param raw - the upstream window object.
 * @returns the window as the browser renders it.
 */
export function projectWindow(key, raw) {
  const entry = raw !== null && typeof raw === 'object' ? raw : {}
  const usedPercent = percentOf(entry.percent)
  return {
    key,
    status: typeof entry.status === 'string' ? entry.status : 'unknown',
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    resetsAt: typeof entry.resetsAt === 'string' ? entry.resetsAt : null,
  }
}

/**
 * Read one error's message.
 * @param error - the thrown value.
 * @returns its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the OpenCode Go API key for exactly this request.
 * @param ctx - the Host context.
 * @returns the key.
 * @throws when the credential is not configured.
 */
async function resolveApiKey(ctx) {
  const resolved = await ctx.credentials.resolve(CREDENTIAL_REF)
  const value = resolved === undefined || resolved === null ? undefined : resolved.value
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`credential "${CREDENTIAL_REF}" is not configured`)
  }
  return value
}

/**
 * Ask the subscription endpoint for the current usage windows.
 * @param apiKey - the OpenCode Go API key.
 * @returns the raw `usage` object.
 * @throws when the endpoint fails or answers something unexpected.
 */
export async function fetchUsage(apiKey) {
  const response = await fetch(USAGE_URL, {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`usage API returned HTTP ${response.status}: ${text.slice(0, 240)}`)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('usage API returned invalid JSON')
  }
  const usage = payload === null ? undefined : payload.usage
  if (usage === null || typeof usage !== 'object') {
    throw new Error('usage API response is missing "usage"')
  }
  return usage
}

/**
 * Collect one projected snapshot.
 * @param ctx - the Host context.
 * @returns the snapshot the route serializes.
 */
export async function collectUsage(ctx) {
  const apiKey = await resolveApiKey(ctx)
  const usage = await fetchUsage(apiKey)
  const windows = {}
  for (const key of WINDOW_KEYS) windows[key] = projectWindow(key, usage[key])
  return { ok: true, provider: 'opencode-go', fetchedAt: Date.now(), windows }
}

/**
 * Host plugin entry: one cached, read-only usage route.
 * @param ctx - the Host context.
 */
export function apply(ctx) {
  // The cache belongs to this fiber, not the module: a module-level cache would
  // outlive unload/reload and serve a value fetched by the previous generation.
  const cache = { at: 0, value: null }
  let inflight = null

  const snapshot = async () => {
    if (cache.value !== null && Date.now() - cache.at < CACHE_MS) return cache.value
    // One cold-cache request drives one upstream call; a burst shares it.
    if (inflight !== null) return inflight
    inflight = collectUsage(ctx)
      .then((value) => {
        cache.at = Date.now()
        cache.value = value
        return value
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: USAGE_PATH,
        handler: async (req, res) => {
          const method = req.method === undefined ? 'GET' : req.method
          if (method !== 'GET' && method !== 'HEAD') {
            res.writeHead(405, {
              allow: 'GET, HEAD',
              'content-type': 'application/json; charset=utf-8',
            })
            res.end(JSON.stringify({ ok: false, provider: 'opencode-go', error: 'method not allowed' }))
            return
          }
          try {
            const body = JSON.stringify(await snapshot())
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(method === 'HEAD' ? undefined : body)
          } catch (error) {
            // Keep the upstream detail host-side: this route is reachable
            // without authentication, so the browser gets a fixed message.
            ctx.logger.warn(`opencode-quota: usage query failed: ${messageOf(error)}`)
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, provider: 'opencode-go', error: 'usage query failed' }))
          }
        },
      }),
    'opencode-quota: usage route',
  )
}

/** Test hook: pure projection helpers. */
export const _internals = { projectWindow, collectUsage, fetchUsage, USAGE_PATH }
