import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 长期链接会落盘到 $DSH_HOME/remote-pair/access.json，测试不能碰真实 home
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'remote-pair-test-'))

import { apply, isLoopbackHost } from '../index.js'

/** Build a fake Host context: captures routes and effects. */
function makeContext() {
  const routes = new Map()
  const taps = []
  const effects = []
  const ctx = {
    webServer: {
      register(route) {
        assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
      tapIndex(transform) {
        taps.push(transform)
        return () => taps.splice(taps.indexOf(transform), 1)
      },
    },
    connection: {
      authenticatedUrl(baseUrl) {
        return `${baseUrl.replace(/\/+$/u, '')}/?token=test-token`
      },
    },
    effect(factory) {
      effects.push(factory())
    },
    logger() {
      return { info() {} }
    },
  }
  return { ctx, routes, taps, effects }
}

/** Build a fake request; `host` decides the owner-only gate. */
function makeRequest({ host = '127.0.0.1:38471', url = '/', headers = {}, ip = '10.0.0.9' } = {}) {
  return {
    url,
    headers: { host, ...headers },
    socket: { remoteAddress: ip },
  }
}

/** Build a fake response capturing status, headers, and body. */
function makeResponse() {
  const capture = { status: 0, headers: {}, body: '' }
  return {
    capture,
    writeHead(status, headers = {}) {
      capture.status = status
      capture.headers = headers
    },
    end(body) {
      if (body !== undefined) capture.body = String(body)
    },
  }
}

/** Call a captured route handler and return what it wrote. */
async function call(routes, path, options) {
  const handler = routes.get(path)
  assert.ok(handler, `route ${path} registered`)
  const res = makeResponse()
  await handler(makeRequest(options), res)
  return res.capture
}

test('isLoopbackHost accepts local authorities only', () => {
  assert.equal(isLoopbackHost('127.0.0.1:38471'), true)
  assert.equal(isLoopbackHost('127.9.9.9'), true)
  assert.equal(isLoopbackHost('[::1]:3080'), true)
  assert.equal(isLoopbackHost('localhost:3080'), true)
  assert.equal(isLoopbackHost('dsh.example.com:8443'), false)
  assert.equal(isLoopbackHost('192.168.1.5:3080'), false)
  assert.equal(isLoopbackHost(undefined), false)
})

test('owner-only routes refuse the tunnel authority', async () => {
  const { ctx, routes } = makeContext()
  apply(ctx, { publicBaseUrl: 'https://dsh.example.com:8443' })
  const state = await call(routes, '/plugins/remote-pair/state', { host: 'dsh.example.com:8443' })
  assert.equal(state.status, 403)
  const qr = await call(routes, '/plugins/remote-pair/qr.svg', { host: 'dsh.example.com:8443' })
  assert.equal(qr.status, 403)
})

test('state issues a six-digit code and a QR svg', async () => {
  const { ctx, routes } = makeContext()
  apply(ctx, { publicBaseUrl: 'https://dsh.example.com:8443', codeTtlSeconds: 60 })
  const state = await call(routes, '/plugins/remote-pair/state')
  assert.equal(state.status, 200)
  const body = JSON.parse(state.body)
  assert.match(body.code, /^\d{6}$/u)
  assert.equal(body.ready, true)
  assert.equal(body.publicBaseUrl, 'https://dsh.example.com:8443')
  assert.ok(body.pairUrl.startsWith('https://dsh.example.com:8443/plugins/remote-pair/pair?code='))
  assert.ok(body.expiresAt > Date.now())

  const qr = await call(routes, '/plugins/remote-pair/qr.svg')
  assert.equal(qr.status, 200)
  assert.equal(qr.headers['content-type'], 'image/svg+xml; charset=utf-8')
  assert.ok(qr.body.startsWith('<svg'))
})

test('wrong code is refused and burns attempts', async () => {
  const { ctx, routes } = makeContext()
  apply(ctx, { publicBaseUrl: 'https://dsh.example.com:8443', maxAttempts: 2 })
  const { code } = JSON.parse((await call(routes, '/plugins/remote-pair/state')).body)
  const wrong = code === '000000' ? '111111' : '000000'
  const first = await call(routes, '/plugins/remote-pair/pair', { url: `/plugins/remote-pair/pair?code=${wrong}` })
  assert.equal(first.status, 403)
  const second = await call(routes, '/plugins/remote-pair/pair', { url: `/plugins/remote-pair/pair?code=${wrong}` })
  assert.equal(second.status, 403)
  // attempts exhausted: even the correct code no longer works
  const third = await call(routes, '/plugins/remote-pair/pair', { url: `/plugins/remote-pair/pair?code=${code}` })
  assert.notEqual(third.status, 302)
})

test('correct code redirects to the launch URL exactly once', async () => {
  const { ctx, routes } = makeContext()
  apply(ctx, { publicBaseUrl: 'https://dsh.example.com:8443' })
  const { code } = JSON.parse((await call(routes, '/plugins/remote-pair/state')).body)
  const first = await call(routes, '/plugins/remote-pair/pair', { url: `/plugins/remote-pair/pair?code=${code}` })
  assert.equal(first.status, 302)
  assert.equal(first.headers.location, 'https://dsh.example.com:8443/?token=test-token')
  const again = await call(routes, '/plugins/remote-pair/pair', { url: `/plugins/remote-pair/pair?code=${code}` })
  assert.equal(again.status, 410)
})

test('missing publicBaseUrl disables pairing instead of guessing', async () => {
  const { ctx, routes } = makeContext()
  apply(ctx, { publicBaseUrl: '' })
  const state = JSON.parse((await call(routes, '/plugins/remote-pair/state')).body)
  assert.equal(state.ready, false)
  const pair = await call(routes, '/plugins/remote-pair/pair', { url: '/plugins/remote-pair/pair?code=123456' })
  assert.equal(pair.status, 503)
})

test('state exposes a long-lived access url', async () => {
  const { ctx, routes } = makeContext()
  apply(ctx, { publicBaseUrl: 'https://dsh.example.com:8443' })
  const body = JSON.parse((await call(routes, '/plugins/remote-pair/state')).body)
  assert.ok(body.accessUrl.startsWith('https://dsh.example.com:8443/plugins/remote-pair/access?key='))
  assert.ok(body.accessUrl.length > 70)
})

test('access url signs a browser in more than once', async () => {
  const { ctx, routes } = makeContext()
  apply(ctx, { publicBaseUrl: 'https://dsh.example.com:8443' })
  const { accessUrl } = JSON.parse((await call(routes, '/plugins/remote-pair/state')).body)
  const query = accessUrl.slice(accessUrl.indexOf('?'))
  const first = await call(routes, '/plugins/remote-pair/access', { url: `/plugins/remote-pair/access${query}` })
  const second = await call(routes, '/plugins/remote-pair/access', { url: `/plugins/remote-pair/access${query}` })
  assert.equal(first.status, 302)
  assert.equal(first.headers.location, 'https://dsh.example.com:8443/?token=test-token')
  assert.equal(second.status, 302, '长期链接可以重复使用（换浏览器也用它）')
})

test('wrong access key is refused', async () => {
  const { ctx, routes } = makeContext()
  apply(ctx, { publicBaseUrl: 'https://dsh.example.com:8443' })
  const denied = await call(routes, '/plugins/remote-pair/access', { url: '/plugins/remote-pair/access?key=deadbeef' })
  assert.equal(denied.status, 403)
})

test('rotate invalidates the previous link and is owner-only', async () => {
  const { ctx, routes } = makeContext()
  apply(ctx, { publicBaseUrl: 'https://dsh.example.com:8443' })
  const before = JSON.parse((await call(routes, '/plugins/remote-pair/state')).body).accessUrl
  const query = before.slice(before.indexOf('?'))

  const forbidden = await call(routes, '/plugins/remote-pair/rotate', { host: 'dsh.example.com:8443' })
  assert.equal(forbidden.status, 403, '公网 Host 不能换链接')

  const rotated = await call(routes, '/plugins/remote-pair/rotate')
  assert.equal(rotated.status, 200)
  const after = JSON.parse(rotated.body).accessUrl
  assert.notEqual(after, before)

  const old = await call(routes, '/plugins/remote-pair/access', { url: `/plugins/remote-pair/access${query}` })
  assert.equal(old.status, 403, '换新之后旧链接立刻失效')
})

test('index taps add the iOS install tags exactly once', async () => {
  const { ctx, taps } = makeContext()
  apply(ctx, { publicBaseUrl: 'https://dsh.example.com:8443' })
  assert.equal(taps.length, 1)
  const html = '<html><head><link rel="manifest" href="./manifest.webmanifest" /></head><body></body></html>'
  const out = taps[0](html)
  assert.match(out, /apple-touch-icon/u)
  assert.match(out, /apple-mobile-web-app-capable/u)
  assert.match(out, /theme-color/u)
  // 已经注入过就不再重复
  assert.equal(taps[0](out), out)
})
