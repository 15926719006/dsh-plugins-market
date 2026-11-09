/**
 * Pack tests for @local/dsh-opencode-quota.
 *
 * - Host: window projection, the usage route's success and failure answers.
 * - Client: registration into the sidebar-foot slot, locale wiring, and the
 *   pure summarize/row models behind the chip and popover.
 *
 * Run with `node --test test/`.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { apply as applyHost, projectWindow, USAGE_PATH } from '../index.js'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE_NAME = '@local/dsh-opencode-quota'

/** Upstream body the fake fetch answers with. */
const USAGE_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 0, resetsAt: '2026-11-04T13:45:29.000Z' },
    weekly: { status: 'ok', percent: 2, resetsAt: '2026-11-09T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 1, resetsAt: '2026-12-04T03:12:36.000Z' },
  },
}

/**
 * Load the Client half against a stub module loader and stub React.
 * Each call re-executes client.js with a fresh module cache key.
 * @returns the module the factory exports.
 */
async function loadClientModule() {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(candidate) {
        definition = candidate
      },
    },
  }
  const url = pathToFileURL(join(PACKAGE_DIR, 'client.js')).href
  await import(`${url}?test=${(loadClientModule.calls = (loadClientModule.calls ?? 0) + 1)}`)
  assert.ok(definition !== undefined, 'client.js must call window.__ModuleLoader__.load')
  assert.equal(definition.id, PACKAGE_NAME, 'the module id must equal the package name')
  const React = {
    createElement: () => null,
    Fragment: Symbol('Fragment'),
    useState: () => [null, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useSyncExternalStore: () => 'zh',
  }
  return definition.factory((id) => {
    assert.equal(id, 'react', 'the Client half only requires React')
    return React
  })
}

/**
 * One Host context carrying a fake web server and credentials seam.
 * @param apiKey - what the credentials seam resolves.
 * @returns the context and a route holder.
 */
function makeHostContext(apiKey) {
  const routes = []
  return {
    routes,
    ctx: {
      credentials: { resolve: async () => ({ value: apiKey, source: 'test' }) },
      logger: { warn: () => {} },
      effect: (factory) => factory(),
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    },
  }
}

/**
 * Invoke one route handler and collect what it wrote.
 * @param route - the registered route.
 * @returns the collected status and body.
 */
async function callRoute(route) {
  const written = { status: 0, body: '' }
  await route.handler({ method: 'GET' }, {
    writeHead(status) {
      written.status = status
    },
    end(body) {
      written.body = body
    },
  })
  return written
}

test('projectWindow clamps a percentage and derives the remainder', () => {
  const window = projectWindow('rolling', { status: 'ok', percent: 130, resetsAt: '2026-11-04T13:45:29.000Z' })
  assert.equal(window.usedPercent, 100)
  assert.equal(window.remainingPercent, 0)
  assert.equal(window.resetsAt, '2026-11-04T13:45:29.000Z')
})

test('projectWindow tolerates a missing window', () => {
  const window = projectWindow('monthly', null)
  assert.equal(window.status, 'unknown')
  assert.equal(window.usedPercent, null)
  assert.equal(window.remainingPercent, null)
  assert.equal(window.resetsAt, null)
})

test('the usage route projects one successful upstream answer', async (t) => {
  const { ctx, routes } = makeHostContext('sk-test')
  applyHost(ctx)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, USAGE_PATH)
  assert.equal(routes[0].kind, 'exact')

  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify(USAGE_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )

  const written = await callRoute(routes[0])
  assert.equal(written.status, 200)
  const payload = JSON.parse(written.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.provider, 'opencode-go')
  assert.equal(payload.windows.rolling.usedPercent, 0)
  assert.equal(payload.windows.weekly.remainingPercent, 98)
  assert.equal(payload.windows.monthly.remainingPercent, 99)
  assert.ok(payload.fetchedAt > 0)
})

test('the usage route hides upstream detail when the credential is missing', async () => {
  const { ctx, routes } = makeHostContext(undefined)
  applyHost(ctx)
  const written = await callRoute(routes[0])
  assert.equal(written.status, 502)
  const payload = JSON.parse(written.body)
  assert.deepEqual(payload, { ok: false, provider: 'opencode-go', error: 'usage query failed' })
  assert.ok(!written.body.includes('OPENCODE_GO_API_KEY'), 'the browser answer must not name the credential')
})

test('the usage route reports an upstream failure without leaking its body', async (t) => {
  const { ctx, routes } = makeHostContext('sk-test')
  applyHost(ctx)
  t.mock.method(globalThis, 'fetch', async () => new Response('{"type":"AuthError"}', { status: 401 }))
  const written = await callRoute(routes[0])
  assert.equal(written.status, 502)
  assert.equal(JSON.parse(written.body).ok, false)
  assert.ok(!written.body.includes('AuthError'), 'the upstream body stays host-side')
})

test('the Client half registers one locale namespace and one sidebar-foot chip', async () => {
  const module = await loadClientModule()
  assert.deepEqual(module.inject, ['slots', 'locale'])

  const localeRegistrations = []
  const slotInjections = []
  const registrations = []
  const ctx = {
    effect: (factory) => factory(),
    locale: {
      register: (ns, dicts) => {
        localeRegistrations.push({ ns, dicts })
        return () => {}
      },
      getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }),
      subscribe: () => () => {},
    },
    slots: {
      inject: (key, callback) => {
        slotInjections.push(key)
        return callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)

  assert.equal(localeRegistrations.length, 1)
  assert.equal(localeRegistrations[0].ns, 'opencode-quota')
  assert.deepEqual(Object.keys(localeRegistrations[0].dicts), ['zh', 'en'])
  assert.deepEqual(slotInjections, ['sidebar.footer.action'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'sidebar.footer.action')
  assert.equal(registrations[0].options.id, 'opencode-quota')
  assert.equal(typeof registrations[0].component, 'function')
})

test('the chip previews the rolling (5h) window, never the monthly one', async () => {
  const { _internals } = await loadClientModule()
  const windows = {
    rolling: { usedPercent: 5, remainingPercent: 95, resetsAt: '2026-11-04T13:45:29.000Z' },
    weekly: { usedPercent: 8, remainingPercent: 92, resetsAt: '2026-11-09T00:00:00.000Z' },
    monthly: { usedPercent: 96, remainingPercent: 4, resetsAt: '2026-12-04T03:12:36.000Z' },
  }
  const summary = _internals.summarize(windows)
  assert.equal(summary.remaining, 95, 'the chip must show the 5-hour window, not the tightest one')
  assert.equal(summary.severity, 'ok')
  assert.equal(summary.resetsAt, '2026-11-04T13:45:29.000Z')
  assert.deepEqual(_internals.summarize(null), { remaining: null, severity: 'idle', resetsAt: null })
  assert.deepEqual(_internals.summarize({ weekly: { usedPercent: 99 } }), {
    remaining: null,
    severity: 'idle',
    resetsAt: null,
  })
  assert.equal(_internals.severityOf(9.4), 'error')
  assert.equal(_internals.severityOf(12), 'warn')
  assert.equal(_internals.severityOf(30), 'ok')
})

test('the chip reset clock is short for today and dated for another day', async () => {
  const { _internals } = await loadClientModule()
  const now = Date.parse('2026-11-04T12:00:00+08:00')
  assert.equal(_internals.formatResetClock('2026-11-04T14:56:00+08:00', 'zh', now), '14:56')
  assert.equal(_internals.formatResetClock('2026-11-05T00:00:00+08:00', 'zh', now), '11/05 00:00')
  assert.equal(_internals.formatResetClock(undefined, 'zh', now), null)
  assert.equal(_internals.formatResetClock('not-a-date', 'zh', now), null)
})

test('row models carry localized remaining, used and reset text', async () => {
  const { _internals } = await loadClientModule()
  const t = (key, params) => _internals.translate(_internals.dictOf('zh'), key, params)
  const windows = {
    rolling: { status: 'ok', usedPercent: 0, remainingPercent: 100, resetsAt: '2026-11-04T13:45:29.000Z' },
    weekly: { status: 'ok', usedPercent: 2, remainingPercent: 98, resetsAt: '2026-11-09T00:00:00.000Z' },
    monthly: { status: 'limited', usedPercent: 1, remainingPercent: 99, resetsAt: null },
  }
  const rows = _internals.rowModels(windows, t, 'zh')
  assert.deepEqual(
    rows.map((row) => row.key),
    ['rolling', 'weekly', 'monthly'],
  )
  assert.equal(rows[1].label, '每周')
  assert.equal(rows[1].remainingText, '剩余 98%')
  assert.equal(rows[1].usedText, '已用 2%')
  assert.equal(typeof rows[1].resetText, 'string')
  assert.equal(rows[2].resetText, null)
  assert.equal(rows[2].statusText, '状态 limited')
  assert.equal(_internals.rowModels(null, t, 'zh').length, 0)
})

test('English dictionaries cover every Chinese key', async () => {
  const { _internals } = await loadClientModule()
  const zh = _internals.dictOf('zh')
  const en = _internals.dictOf('en')
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  assert.equal(_internals.translate(en, 'window.remaining', { value: 12 }), '12% left')
  assert.equal(_internals.translate(zh, 'missing.key'), 'missing.key')
})

test('the pack manifest exposes the bundle patch and both halves', async () => {
  const manifest = JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  assert.equal(manifest.name, PACKAGE_NAME)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  const icon = await readFile(join(PACKAGE_DIR, 'icon.svg'), 'utf8')
  assert.ok(icon.trimStart().startsWith('<svg'))
  const patch = await readFile(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('id: opencode-quota'))
  assert.ok(patch.includes(`name: '${PACKAGE_NAME}'`))
})

test('non-finite percentages are treated as missing, not rendered as NaN', async () => {
  const { _internals } = await loadClientModule()
  const t = (key, params) => _internals.translate(_internals.dictOf('en'), key, params)
  const rows = _internals.rowModels(
    {
      rolling: { status: 'ok', usedPercent: Number.NaN, remainingPercent: Number.NaN },
      weekly: { status: 'ok', usedPercent: 2, remainingPercent: 98 },
      monthly: {},
    },
    t,
    'en',
  )
  assert.equal(rows[0].remaining, null)
  assert.equal(rows[0].remainingText, 'No data')
  assert.equal(rows[2].remaining, null)
  assert.deepEqual(_internals.summarize({ rolling: { usedPercent: Number.NaN } }), {
    remaining: null,
    severity: 'idle',
    resetsAt: null,
  })
})

test('the usage route accepts only GET and HEAD', async (t) => {
  const { ctx, routes } = makeHostContext('sk-test')
  applyHost(ctx)
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify(USAGE_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )

  const write = async (method) => {
    const written = { status: 0, body: undefined, head: undefined }
    await routes[0].handler({ method }, {
      writeHead(status, headers) {
        written.status = status
        written.head = headers
      },
      end(body) {
        written.body = body
      },
    })
    return written
  }

  const post = await write('POST')
  assert.equal(post.status, 405)
  assert.equal(post.head.allow, 'GET, HEAD')
  assert.equal(JSON.parse(post.body).ok, false)

  const head = await write('HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.body, undefined)
})

test('a cold-cache burst shares one upstream request', async (t) => {
  const { ctx, routes } = makeHostContext('sk-test')
  applyHost(ctx)

  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    await gate
    return new Response(JSON.stringify(USAGE_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })

  const first = callRoute(routes[0])
  const second = callRoute(routes[0])
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 1, 'a cold-cache burst must issue one upstream call')
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.equal(JSON.parse(b.body).windows.weekly.remainingPercent, 98)
})
