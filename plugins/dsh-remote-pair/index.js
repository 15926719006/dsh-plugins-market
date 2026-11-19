/**
 * Host half of `@local/dsh-remote-pair`: 手机扫码配对。
 *
 * 三件事：
 *
 * 1. 维护一个 6 位一次性配对码（默认 60 秒有效、最多试 5 次、用掉即作废）；
 * 2. 给桌面页面提供读状态、换新码、取二维码 SVG 三个**仅限本机**的接口；
 * 3. 给手机提供 `/plugins/remote-pair/pair?code=` 这个公开入口：校验通过后
 *    直接把手机 302 到 DSH 自己的 `authenticatedUrl()`，由 DSH 签发会话
 *    cookie。插件本身不碰签名密钥、不生成 cookie，所以 DSH 升级不会破坏它。
 *
 * 安全边界：桌面侧接口只认 loopback 的 Host。隧道转发过来的请求 Host 是
 * 公网域名，一旦命中这条判断就直接 403——否则任何扫到 8443 的人都能读到
 * 当前配对码，自己配上对。
 *
 * @module @local/dsh-remote-pair
 */

import { randomBytes, randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isIPv4, isIPv6 } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const qrcode = require('./vendor/qrcode.cjs')

/** Cordis plugin name. */
export const name = 'remote-pair'

/** 需要浏览器 HTTP 载体，以及拿一次性登录链接的 Connection 服务。 */
export const inject = ['webServer', 'connection']

/** 桌面侧状态/换码/二维码的路由前缀。 */
export const BASE_PATH = '/plugins/remote-pair'

/** 手机侧配对入口。 */
export const PAIR_PATH = `${BASE_PATH}/pair`

/** 二维码 SVG。 */
export const QR_PATH = `${BASE_PATH}/qr.svg`

/** 手输 6 位码的落地页（手机浏览器直接打开这个地址即可）。 */
export const ENTER_PATH = `${BASE_PATH}/enter`

/** 长期访问链接：一次生成，任何浏览器打开都能登进来，直到主动换新。 */
export const ACCESS_PATH = `${BASE_PATH}/access`

/** 重新生成长期链接。 */
export const ROTATE_PATH = `${BASE_PATH}/rotate`

/** 长期链接的存放位置（$DSH_HOME/remote-pair/access.json，600）。 */
function storeFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'remote-pair', 'access.json')
}

/** 配对码默认有效期（毫秒）。 */
const DEFAULT_TTL_MS = 60_000

/** 配对码失败尝试上限，超过即作废。 */
const DEFAULT_MAX_ATTEMPTS = 5

/** 同一个来源 IP 每分钟最多提交几次配对码。 */
const RATE_LIMIT_PER_MINUTE = 10

/**
 * 判断一个 Host 头是否只可能来自本机。
 * @param {string | undefined} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host === '') return false
  const bare = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (bare === 'localhost') return true
  if (isIPv4(bare)) return bare.startsWith('127.')
  if (isIPv6(bare)) return bare === '::1' || bare === '0:0:0:0:0:0:0:1'
  return false
}

/** 6 位数字码，前导零保留。 */
function freshCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** 读请求里的 Host。 */
function hostOf(req) {
  const value = req.headers.host
  return Array.isArray(value) ? value[0] : value
}

/** 读请求里的来源地址（nginx 会带 x-forwarded-for）。 */
function sourceOf(req) {
  const forwarded = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof raw === 'string' && raw !== '') return raw.split(',')[0].trim()
  return req.socket?.remoteAddress ?? 'unknown'
}

/** 写一个 JSON 响应。 */
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 写一个最小的中文提示页（手机侧看到的就是它）。 */
function sendPage(res, status, title, detail) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#111;color:#eee;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:22rem;padding:2rem;text-align:center">
<div style="font-size:1.25rem;font-weight:600;margin-bottom:.75rem">${title}</div>
<div style="color:#9aa;white-space:pre-line">${detail}</div>
</div></body></html>`
  const payload = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ publicBaseUrl?: string, codeTtlSeconds?: number, maxAttempts?: number }} [config]
 */
export function apply(ctx, config = {}) {
  /** 公网入口；手机扫码后必须能访问到它。 */
  const publicBaseUrl = String(
    config.publicBaseUrl ?? process.env.DSH_REMOTE_PUBLIC_URL ?? '',
  ).replace(/\/+$/u, '')
  const ttlMs = Math.max(15_000, Number(config.codeTtlSeconds ?? 60) * 1000)
  const maxAttempts = Math.max(1, Number(config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))

  const state = { code: '', expiresAt: 0, attempts: 0 }
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const rate = new Map()

  const pairUrlFor = (code) => `${publicBaseUrl}${PAIR_PATH}?code=${code}`
  const accessUrlFor = (key) => `${publicBaseUrl}${ACCESS_PATH}?key=${key}`

  /** 读长期 key；首次使用时生成并落盘（600）。 */
  const loadAccess = () => {
    const file = storeFile()
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof saved.key === 'string' && saved.key.length >= 32) return saved
    } catch {
      // 没有或坏掉就重新生成
    }
    const created = { key: randomBytes(24).toString('hex'), createdAt: Date.now() }
    try {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, JSON.stringify(created), { mode: 0o600 })
    } catch {
      // 落盘失败仍然可用，只是重启后会换链接
    }
    return created
  }

  let access = loadAccess()

  const issue = () => {
    state.code = freshCode()
    state.expiresAt = Date.now() + ttlMs
    state.attempts = 0
    return state
  }

  const current = () => {
    if (publicBaseUrl === '') return { ...state, expiresAt: 0 }
    if (state.code === '' || Date.now() > state.expiresAt) issue()
    return state
  }

  const status = () => {
    const live = current()
    const remaining = Math.max(0, live.expiresAt - Date.now())
    return {
      ready: publicBaseUrl !== '',
      publicBaseUrl,
      code: live.code,
      expiresAt: live.expiresAt,
      remainingMs: remaining,
      ttlMs,
      pairUrl: live.code === '' ? '' : pairUrlFor(live.code),
      accessUrl: accessUrlFor(access.key),
      attemptsLeft: Math.max(0, maxAttempts - live.attempts),
    }
  }

  const renderQr = () => {
    if (publicBaseUrl === '') return ''
    const qr = qrcode(0, 'M')
    qr.addData(accessUrlFor(access.key))
    qr.make()
    // cellSize 固定，生成的 SVG 自带 width/height；<img> 靠它拿到内在尺寸，
    // 否则浏览器按 300x150 处理，二维码会被拉成扁的、扫不出来
    return qr.createSvgTag({ cellSize: 7, margin: 2 })
  }

  /** 桌面侧接口的统一闸门。 */
  const ownerOnly = (req, res) => {
    if (isLoopbackHost(hostOf(req))) return true
    sendJson(res, 403, { error: 'forbidden', detail: 'this endpoint is only available on the host machine' })
    return false
  }

  /** 同一 IP 的配对码尝试限流。 */
  const allowRate = (ip) => {
    const now = Date.now()
    const slot = rate.get(ip)
    if (slot === undefined || now > slot.resetAt) {
      rate.set(ip, { count: 1, resetAt: now + 60_000 })
      return true
    }
    if (slot.count >= RATE_LIMIT_PER_MINUTE) return false
    slot.count += 1
    return true
  }

  // 让浏览器把这一页当成可安装的 Web App。DSH 自带的 manifest 已经声明了
  // display: standalone 与 192/512 图标，这里只补它缺的 iOS 标签，已有的不重复加。
  ctx.effect(
    () => ctx.webServer.tapIndex((html) => {
      const wanted = [
        ['apple-touch-icon', '<link rel="apple-touch-icon" href="/icon-192.png" />'],
        ['name="theme-color"', '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />'
          + '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#101010" />'],
        ['apple-mobile-web-app-capable', '<meta name="apple-mobile-web-app-capable" content="yes" />'],
        ['mobile-web-app-capable', '<meta name="mobile-web-app-capable" content="yes" />'],
        ['apple-mobile-web-app-status-bar-style',
          '<meta name="apple-mobile-web-app-status-bar-style" content="default" />'],
      ]
      const missing = wanted.filter(([needle]) => !html.includes(needle)).map(([, tag]) => tag).join('')
      return missing === '' ? html : html.replace('</head>', `${missing}</head>`)
    }),
    'remote-pair: pwa head tags',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${BASE_PATH}/state`,
      handler: (req, res) => {
        if (!ownerOnly(req, res)) return
        sendJson(res, 200, status())
      },
    }),
    'remote-pair: state',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${BASE_PATH}/refresh`,
      handler: (req, res) => {
        if (!ownerOnly(req, res)) return
        issue()
        sendJson(res, 200, status())
      },
    }),
    'remote-pair: refresh',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ACCESS_PATH,
      handler: (req, res) => {
        if (publicBaseUrl === '') {
          sendPage(res, 503, '还没配置公网地址', '请在插件配置里填 publicBaseUrl。')
          return
        }
        const ip = sourceOf(req)
        if (!allowRate(ip)) {
          sendPage(res, 429, '试得太频繁了', '等一分钟再打开这个链接。')
          return
        }
        const url = new URL(req.url ?? '/', 'http://pair.invalid')
        const given = (url.searchParams.get('key') ?? '').trim()
        if (given === '' || given !== access.key) {
          sendPage(res, 403, '链接无效', '这个长期链接已经换新了，回电脑上看当前那张二维码。')
          return
        }
        res.writeHead(302, {
          location: ctx.connection.authenticatedUrl(`${publicBaseUrl}/`),
          'cache-control': 'no-store',
        })
        res.end()
      },
    }),
    'remote-pair: access',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROTATE_PATH,
      handler: (req, res) => {
        if (!ownerOnly(req, res)) return
        access = { key: randomBytes(24).toString('hex'), createdAt: Date.now() }
        try {
          writeFileSync(storeFile(), JSON.stringify(access), { mode: 0o600 })
        } catch {
          // 落盘失败不影响本次运行
        }
        sendJson(res, 200, status())
      },
    }),
    'remote-pair: rotate',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: QR_PATH,
      handler: (req, res) => {
        if (!ownerOnly(req, res)) return
        const svg = renderQr()
        if (svg === '') {
          sendJson(res, 409, { error: 'not-configured' })
          return
        }
        const payload = Buffer.from(svg, 'utf8')
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'content-length': String(payload.length),
          'cache-control': 'no-store',
        })
        res.end(payload)
      },
    }),
    'remote-pair: qr',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ENTER_PATH,
      handler: (req, res) => {
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>输入配对码</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#111;color:#eee;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<form method="get" action="${PAIR_PATH}" style="width:20rem;padding:2rem;text-align:center">
<div style="font-size:1.15rem;font-weight:600;margin-bottom:1rem">输入电脑上显示的 6 位码</div>
<input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code"
 style="width:100%;box-sizing:border-box;padding:.75rem;font-size:1.6rem;letter-spacing:.4em;
 text-align:center;border-radius:.6rem;border:1px solid #444;background:#1b1b1b;color:#eee">
<button type="submit" style="margin-top:1rem;width:100%;padding:.75rem;font-size:1rem;border:0;
 border-radius:.6rem;background:#3b6cf6;color:#fff">登录</button>
</form></body></html>`
        const payload = Buffer.from(html, 'utf8')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(payload.length),
          'cache-control': 'no-store',
        })
        res.end(payload)
      },
    }),
    'remote-pair: enter',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: PAIR_PATH,
      handler: (req, res) => {
        if (publicBaseUrl === '') {
          sendPage(res, 503, '还没配置公网地址', '请在插件配置里填 publicBaseUrl。')
          return
        }
        const ip = sourceOf(req)
        if (!allowRate(ip)) {
          sendPage(res, 429, '试得太频繁了', '等一分钟再扫一次二维码。')
          return
        }
        const url = new URL(req.url ?? '/', 'http://pair.invalid')
        const given = (url.searchParams.get('code') ?? '').trim()
        // 只读快照：配对失败不能顺手发一张新码，否则「试错上限」形同虚设
        const live = state
        if (live.code === '' || Date.now() > live.expiresAt) {
          sendPage(res, 410, '配对码已过期', '回到电脑上重新生成一个二维码。')
          return
        }
        if (given === '' || given !== live.code) {
          state.attempts += 1
          if (state.attempts >= maxAttempts) state.code = ''
          sendPage(res, 403, '配对码不对', '回电脑上看一眼当前这 6 位数字。')
          return
        }
        // 一次性：成功即作废，避免链接被转发后重复使用
        state.code = ''
        state.expiresAt = 0
        const target = ctx.connection.authenticatedUrl(`${publicBaseUrl}/`)
        res.writeHead(302, { location: target, 'cache-control': 'no-store' })
        res.end()
      },
    }),
    'remote-pair: pair',
  )

  ctx.logger?.('remote-pair').info?.('pairing endpoints ready: %s', publicBaseUrl === '' ? '(publicBaseUrl missing)' : publicBaseUrl)
}
