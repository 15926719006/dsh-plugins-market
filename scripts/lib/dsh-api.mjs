/**
 * Talk to the running DSH Host over its HTTP API from a plain shell.
 *
 * The Web UI authenticates with a browser-session cookie signed by the Host. This module mints the same cookie from
 * `~/.dsh/.credentials.yaml` and posts typert gateway messages, which is how `publish.mjs` installs a plugin into the
 * profile the running app uses without going through the UI.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const b64u = (buffer) => Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/** The origin of the running DSH: `--origin`, `$DSH_ORIGIN`, `$DSH_WEB_URL`, else the listener owned by the desktop app. */
export function detectOrigin() {
  for (const value of [process.env.DSH_ORIGIN, process.env.DSH_WEB_URL]) {
    if (value !== undefined && value.trim() !== '') return value.trim().replace(/\/+$/u, '')
  }
  try {
    const listing = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
    for (const line of listing.split('\n')) {
      if (!/DeepSeek Harness|dsh-desktop-host/u.test(line)) continue
      const match = /127\.0\.0\.1:(\d+)/u.exec(line)
      if (match !== null) return `http://127.0.0.1:${match[1]}`
    }
  } catch {
    // lsof missing or refused; the error below explains the remedy.
  }
  throw new Error('无法定位运行中的 DSH：请先启动 DSH，或用 --origin http://127.0.0.1:<端口> 指定')
}

function browserSecret() {
  const yaml = readFileSync(`${process.env.HOME}/.dsh/.credentials.yaml`, 'utf8')
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/u.exec(yaml)
  if (match === null) throw new Error('~/.dsh/.credentials.yaml 里没有 browser-session 密钥')
  return Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

/** A signed browser-session cookie for one origin. */
export function mintCookie(origin) {
  const authority = new URL(origin).host
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 24 * 3600 * 1000 }
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = b64u(createHmac('sha256', browserSecret()).update(body).digest())
  return `dsh-auth-${b64u(createHash('sha256').update(authority).digest())}=v1.${body}.${signature}`
}

/**
 * Call one gateway endpoint, like `pluginManager/installBundle`, with an `args` payload.
 * @returns the gateway response body; throws when the call itself fails.
 */
export async function call(method, args, options = {}) {
  const origin = options.origin ?? detectOrigin()
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: mintCookie(origin) },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${method} 返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}：${JSON.stringify(body).slice(0, 300)}`)
  if (body?.result?.ok === false) {
    const error = body.result.error
    const detail = error?.diagnostic ?? error?.message ?? JSON.stringify(error)
    throw new Error(`${method} 被拒绝（${error?.code ?? 'unknown'}）：${String(detail).slice(0, 600)}`)
  }
  return body?.result?.value ?? body?.result ?? body
}
